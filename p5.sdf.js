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
  // can find the struct definition via shader._fragSrc. TODO: Update p5 upstream
  // to be able to read this out of declarations instead, and to let fragDeclarations
  // work in the constructor
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
            float _sdfShininess;
            float _sdfMetalness;
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
              _sdfShininess = hitResult.shininess;
              _sdfMetalness = hitResult.metalness;

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
              totalLight(_sdfHitViewPos, _sdfNormal, _sdfShininess, _sdfMetalness, diffuse, specular);
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

    // Capture defaults before any assignments
    const defaults = {
      color: hook.color,
      ambient: hook.ambient,
      specular: hook.specular,
      emissive: hook.emissive,
      shininess: hook.shininess,
      metalness: hook.metalness,
    };

    const emptyMat = { color: null, ambient: null, specular: null, emissive: null, shininess: null, metalness: null };

    // Each stack frame holds the current transformed point, pending boolean op, and material overrides
    const stack = [{ point: initialPoint, op: 'union', opK: 0, mat: { ...emptyMat } }];
    const top = () => stack[stack.length - 1];

    let result = null; // { dist, color, ambient, specular, emissive, shininess, metalness }

    const computeMaterial = hook.computeMaterial;

    const sminH = (a, b, k) => {
      k = p5.strandsNode(k);
      return sketch.clamp(
        p5.strandsNode(0.5).add(p5.strandsNode(0.5).mult(b.sub(a).div(k))),
        0.0,
        1.0
      );
    };

    // w=1 means a (existing) wins, w=0 means b (new shape) wins
    const mixMat = (a, b, w) => ({
      color: p5.strandsTernary(computeMaterial, sketch.mix(b.color, a.color, w), a.color),
      ambient: p5.strandsTernary(computeMaterial, sketch.mix(b.ambient, a.ambient, w), a.ambient),
      specular: p5.strandsTernary(computeMaterial, sketch.mix(b.specular, a.specular, w), a.specular),
      emissive: p5.strandsTernary(computeMaterial, sketch.mix(b.emissive, a.emissive, w), a.emissive),
      shininess: p5.strandsTernary(computeMaterial, sketch.mix(b.shininess, a.shininess, w), a.shininess),
      metalness: p5.strandsTernary(computeMaterial, sketch.mix(b.metalness, a.metalness, w), a.metalness),
    });

    const combine = (existing, d, shapeMat) => {
      const { op, opK } = top();
      if (existing === null) return { dist: d, ...shapeMat };

      if (op === 'union') {
        const w = sketch.step(existing.dist, d); // 1 when existing wins
        return { dist: sketch.min(existing.dist, d), ...mixMat(existing, shapeMat, w) };
      }
      if (op === 'subtract') {
        return { dist: sketch.max(existing.dist, d.mult(-1)), ...existing };
      }
      if (op === 'smoothUnion') {
        const h = sminH(existing.dist, d, opK);
        const k = p5.strandsNode(opK);
        return {
          dist: sketch.mix(d, existing.dist, h).sub(k.mult(h).mult(p5.strandsNode(1.0).sub(h))),
          ...mixMat(existing, shapeMat, h),
        };
      }
      return { dist: sketch.min(existing.dist, d), ...existing };
    };

    return {
      push() {
        const { point, op, opK, mat } = top();
        stack.push({ point, op, opK, mat: { ...mat } });
      },
      pop() {
        if (stack.length > 1) stack.pop();
      },
      translate(x, y, z) {
        top().point = top().point.sub(sketch.vec3(x, y, z));
      },
      union() { top().op = 'union'; top().opK = 0; },
      subtract() { top().op = 'subtract'; top().opK = 0; },
      smoothUnion(k) { top().op = 'smoothUnion'; top().opK = k; },
      fill(...args) {
        const c = sketch.color(...args);
        top().mat.color = c;
        top().mat.ambient = sketch.vec3(c.r, c.g, c.b);
      },
      ambient(r, g, b) {
        top().mat.ambient = sketch.vec3(r / 255, g / 255, b / 255);
      },
      specular(r, g, b) {
        top().mat.specular = sketch.vec3(r / 255, g / 255, b / 255);
      },
      emissive(r, g, b) {
        top().mat.emissive = sketch.vec3(r / 255, g / 255, b / 255);
      },
      shininess(v) { top().mat.shininess = p5.strandsNode(v); },
      metalness(v) { top().mat.metalness = p5.strandsNode(v); },
      sphere(r) {
        const d = sketch.length(top().point).sub(r);
        const m = top().mat;
        const shapeMat = {
          color: m.color ?? defaults.color,
          ambient: m.ambient ?? defaults.ambient,
          specular: m.specular ?? defaults.specular,
          emissive: m.emissive ?? defaults.emissive,
          shininess: m.shininess ?? defaults.shininess,
          metalness: m.metalness ?? defaults.metalness,
        };
        result = combine(result, d, shapeMat);
        top().op = 'union';
        top().opK = 0;
      },
      apply() {
        if (result === null) return;
        hook.dist = result.dist;
        hook.color = result.color;
        hook.ambient = result.ambient;
        hook.specular = result.specular;
        hook.emissive = result.emissive;
        hook.shininess = result.shininess;
        hook.metalness = result.metalness;
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
