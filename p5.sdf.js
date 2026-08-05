function sdf(p5, fn) {
  function injectAfterLastPrecision(src, injection) {
    const lines = src.split('\n');
    let lastPrecisionIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*precision\s+/.test(lines[i])) lastPrecisionIdx = i;
    }
    const insertAt = lastPrecisionIdx === -1 ? 0 : lastPrecisionIdx + 1;
    lines.splice(insertAt, 0, injection);
    return lines.join('\n');
  }

  // Injected into _fragSrc (after precision declarations) so the hook type parser
  // can find the struct definition via shader._fragSrc. Also a good place for
  // fragment-only uniforms already declared in phong.vert -- putting them in
  // `declarations` would cause redefinition errors since that block goes to both stages.
  // Also a good place for fragment-only uniforms that are already declared in
  // phong.vert -- putting them in `declarations` would cause redefinition errors
  // since that block is emitted into both stages.
  const fragPrefix = `
    struct SDFResult {
      float dist;
      vec4 color;
      vec3 ambient;
      vec3 specular;
      vec3 emissive;
      float shininess;
      float metalness;
    };
    uniform mat4 uProjectionMatrix;
    uniform mat3 uNormalMatrix;
  `;

  fn.baseSDFShader = function() {
    if (!this._baseSDFShader) {
      const base = this.baseMaterialShader();
      this._baseSDFShader = new p5.Shader(
        base._renderer,
        base._vertSrc,
        injectAfterLastPrecision(base._fragSrc, fragPrefix),
        {
          declarations: `
            uniform mat4 uInverseModelViewMatrix;
            uniform mat4 uInverseProjectionMatrix;
            uniform float uSDFMaxDist;
            uniform vec4 uViewport;

            vec3 _sdfHitViewPos;
            vec3 _sdfNormal;
          `,
          uniforms: {
            ...base.hooks.uniforms,
          },
          vertex: {
            ...base.hooks.vertex,
          },
          fragment: {
            'SDFResult sdfScene': `(SDFResult result, vec3 point, bool computeMaterial) {
              result.dist = length(point) - 1.0;
              return result;
            }`,
            ...base.hooks.fragment,
            'Inputs getPixelInputs': `(Inputs inputs) {
              vec2 ndc = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw * 2.0 - 1.0;
              vec4 p0 = uInverseProjectionMatrix * vec4(ndc, -1.0, 1.0);
              p0 /= p0.w;
              vec4 p1 = uInverseProjectionMatrix * vec4(ndc, 1.0, 1.0);
              p1 /= p1.w;
              vec3 rayDir = normalize(p1.xyz - p0.xyz);
              vec3 rayOrigin = vViewPosition;

              SDFResult defaultResult;
              defaultResult.color = inputs.color;
              defaultResult.ambient = inputs.ambientMaterial;
              defaultResult.specular = inputs.specularMaterial;
              defaultResult.emissive = inputs.emissiveMaterial;
              defaultResult.shininess = inputs.shininess;
              defaultResult.metalness = inputs.metalness;

              float t = 0.0;
              bool hit = false;
              float prevD = 1e10;
              float prevT = 0.0;
              for (int i = 0; i < 256; i++) {
                vec3 viewPos = rayOrigin + t * rayDir;
                vec3 sdfPos = (uInverseModelViewMatrix * vec4(viewPos, 1.0)).xyz;
                defaultResult.dist = 1e10;
                float d = HOOK_sdfScene(defaultResult, sdfPos, false).dist;
                if (d < 0.01) { hit = true; break; }
                if (t > uSDFMaxDist) break;
                // Near surface tangents, d shrinks toward zero and rays stall,
                // exhausting iterations before reaching geometry behind. Stepping
                // 1.2x when converging lets rays escape; revert on overshoot.
                if (d < prevD) {
                  prevT = t;
                  prevD = d;
                  t += d * 1.2;
                } else {
                  t = prevT + prevD;
                  prevD = 1e10;
                }
              }

              if (!hit) discard;

              vec3 hitViewPos = rayOrigin + t * rayDir;
              vec3 hitSdfPos = (uInverseModelViewMatrix * vec4(hitViewPos, 1.0)).xyz;

              defaultResult.dist = 1e10;
              SDFResult hitResult = HOOK_sdfScene(defaultResult, hitSdfPos, true);

              float eps = 0.5;
              vec2 k = vec2(1.0, -1.0);
              defaultResult.dist = 1e10;
              vec3 sdfNormal = normalize(
                k.xyy * HOOK_sdfScene(defaultResult, hitSdfPos + eps * k.xyy, false).dist +
                k.yyx * HOOK_sdfScene(defaultResult, hitSdfPos + eps * k.yyx, false).dist +
                k.yxy * HOOK_sdfScene(defaultResult, hitSdfPos + eps * k.yxy, false).dist +
                k.xxx * HOOK_sdfScene(defaultResult, hitSdfPos + eps * k.xxx, false).dist
              );

              _sdfHitViewPos = hitViewPos;
              _sdfNormal = normalize(uNormalMatrix * sdfNormal);

              inputs.normal = _sdfNormal;
              inputs.color = hitResult.color;
              inputs.shininess = hitResult.shininess;
              inputs.metalness = hitResult.metalness;
              inputs.ambientMaterial = hitResult.ambient;
              inputs.specularMaterial = hitResult.specular;
              inputs.emissiveMaterial = hitResult.emissive;

              vec4 clipPos = uProjectionMatrix * vec4(hitViewPos, 1.0);
              gl_FragDepth = (clipPos.z / clipPos.w + 1.0) * 0.5;

              return inputs;
            }`,
            'vec4 combineColors': `(ColorComponents components) {
              vec3 diffuse;
              vec3 specular;
              totalLight(_sdfHitViewPos, _sdfNormal, uShininess, uMetallic, diffuse, specular);
              vec4 color = vec4(0.0);
              color.rgb += diffuse * components.baseColor;
              color.rgb += components.ambient * components.ambientColor;
              color.rgb += specular * components.specularColor;
              color.rgb += components.emissive;
              color.a = components.opacity;
              return color;
            }`,
          },
        }
      );
    }
    return this._baseSDFShader;
  };

  fn.distanceFunction = function(hook) {
    const sketch = this;
    const initialPoint = hook.point;

    // Each stack frame holds the current transformed point and the pending boolean op.
    const stack = [{ point: initialPoint, op: 'union', opK: 0 }];
    const top = () => stack[stack.length - 1];

    let result = null;

    const smin = (a, b, k) => {
      k = p5.strandsNode(k);
      const h = sketch.clamp(
        p5.strandsNode(0.5).add(p5.strandsNode(0.5).mult(b.sub(a).div(k))),
        0.0,
        1.0
      );
      return sketch.mix(b, a, h).sub(k.mult(h).mult(p5.strandsNode(1.0).sub(h)));
    };

    const combine = (existing, d) => {
      const { op, opK } = top();
      if (existing === null) return d;
      if (op === 'union') return sketch.min(existing, d);
      if (op === 'subtract') return sketch.max(existing, d.mult(-1));
      if (op === 'smoothUnion') return smin(existing, d, opK);
      return sketch.min(existing, d);
    };

    return {
      push() {
        const { point, op, opK } = top();
        stack.push({ point, op, opK });
      },
      pop() {
        if (stack.length > 1) stack.pop();
      },
      translate(x, y, z) {
        top().point = top().point.sub(sketch.vec3(x, y, z));
      },
      union() {
        top().op = 'union';
        top().opK = 0;
      },
      subtract() {
        top().op = 'subtract';
        top().opK = 0;
      },
      smoothUnion(k) {
        top().op = 'smoothUnion';
        top().opK = k;
      },
      sphere(r) {
        const d = sketch.length(top().point).sub(r);
        result = combine(result, d);
        top().op = 'union';
        top().opK = 0;
      },
      get() {
        return result !== null ? result : p5.strandsNode(1e10);
      },
    };
  };

  fn.buildSDF = function(callback) {
    const sketch = this;
    const shader = this.baseSDFShader().modify(callback);

    return {
      shader,
      setUniform(name, value) {
        shader.setUniform(name, value);
        return this;
      },
      draw(radiusOrCallback = 200) {
        sketch.push();
        sketch.shader(shader);

        const renderer = sketch._renderer;
        const mvMatrix = renderer.uMVMatrix;
        mvMatrix.invert(mvMatrix);
        shader.setUniform('uInverseModelViewMatrix', mvMatrix.mat4);

        const pMatrix = renderer.uPMatrix.copy();
        pMatrix.invert(pMatrix);
        shader.setUniform('uInverseProjectionMatrix', pMatrix.mat4);

        if (typeof radiusOrCallback === 'number') {
          const r = radiusOrCallback;
          shader.setUniform('uSDFMaxDist', r * 2.0);
          sketch.sphere(r);
        } else {
          radiusOrCallback();
        }

        sketch.pop();
      },
    };
  };
}

if (typeof p5 !== 'undefined') {
  p5.registerAddon(sdf);
}
