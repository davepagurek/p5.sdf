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
              for (int i = 0; i < 256; i++) {
                vec3 viewPos = rayOrigin + t * rayDir;
                vec3 sdfPos = (uInverseModelViewMatrix * vec4(viewPos, 1.0)).xyz;
                defaultResult.dist = 1e10;
                float d = HOOK_sdfScene(defaultResult, sdfPos, false).dist;
                if (d < 0.001) { hit = true; break; }
                if (t > uSDFMaxDist) break;
                t += d;
              }

              if (!hit) discard;

              vec3 hitViewPos = rayOrigin + t * rayDir;
              vec3 hitSdfPos = (uInverseModelViewMatrix * vec4(hitViewPos, 1.0)).xyz;

              defaultResult.dist = 1e10;
              SDFResult hitResult = HOOK_sdfScene(defaultResult, hitSdfPos, true);

              float eps = 0.001;
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

    // Each stack frame holds: transformed point, pending boolean op, material overrides,
    // cumulative scale factor (for distance correction), and a composed distance modifier.
    const stack = [{ point: initialPoint, op: 'union', opK: 0, mat: { ...emptyMat }, scale: 1, mod: null }];
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

    const existingMat = (existing) => ({
      color: existing.color,
      ambient: existing.ambient,
      specular: existing.specular,
      emissive: existing.emissive,
      shininess: existing.shininess,
      metalness: existing.metalness,
    });

    const combine = (existing, d, shapeMat) => {
      const { op, opK } = top();
      if (existing === null) return { dist: d, ...shapeMat };

      if (op === 'union') {
        const w = sketch.step(existing.dist, d); // 1 when existing wins
        return { dist: sketch.min(existing.dist, d), ...mixMat(existing, shapeMat, w) };
      }
      if (op === 'subtract') {
        return { dist: sketch.max(existing.dist, d.mult(-1)), ...existingMat(existing) };
      }
      if (op === 'intersect') {
        const w = sketch.step(d, existing.dist); // 1 when existing >= d (existing surface visible)
        return { dist: sketch.max(existing.dist, d), ...mixMat(existing, shapeMat, w) };
      }
      if (op === 'smoothUnion') {
        const h = sminH(existing.dist, d, opK);
        const k = p5.strandsNode(opK);
        return {
          dist: sketch.mix(d, existing.dist, h).sub(k.mult(h).mult(p5.strandsNode(1.0).sub(h))),
          ...mixMat(existing, shapeMat, h),
        };
      }
      if (op === 'smoothSubtract') {
        const neg_d = d.mult(p5.strandsNode(-1.0));
        const h = sminH(existing.dist, neg_d, opK);
        const k = p5.strandsNode(opK);
        return {
          dist: sketch.mix(existing.dist, neg_d, h).add(k.mult(h).mult(p5.strandsNode(1.0).sub(h))),
          ...existingMat(existing),
        };
      }
      if (op === 'smoothIntersect') {
        const h = sminH(existing.dist, d, opK);
        const k = p5.strandsNode(opK);
        return {
          dist: sketch.mix(existing.dist, d, h).add(k.mult(h).mult(p5.strandsNode(1.0).sub(h))),
          ...mixMat(existing, shapeMat, p5.strandsNode(1.0).sub(h)),
        };
      }
      return { dist: sketch.min(existing.dist, d), ...existingMat(existing) };
    };

    return {
      push() {
        const { point, op, opK, mat, scale, mod } = top();
        stack.push({ point, op, opK, mat: { ...mat }, scale, mod });
      },
      pop() {
        if (stack.length > 1) stack.pop();
      },

      ////////////////////////
      // TRANSFORMS
      ////////////////////////
      translate(x, y, z) {
        top().point = top().point.sub(sketch.vec3(x, y, z));
      },
      scale(s) {
        top().point = top().point.div(p5.strandsNode(s));
        top().scale = top().scale * s;
      },
      mirror(axis) {
        const p = top().point;
        if (axis === 'x') top().point = sketch.vec3(sketch.abs(p.x), p.y, p.z);
        else if (axis === 'y') top().point = sketch.vec3(p.x, sketch.abs(p.y), p.z);
        else if (axis === 'z') top().point = sketch.vec3(p.x, p.y, sketch.abs(p.z));
      },
      elongate(hx, hy, hz) {
        const p = top().point;
        top().point = p.sub(sketch.clamp(p, sketch.vec3(-hx, -hy, -hz), sketch.vec3(hx, hy, hz)));
      },
      twist(k) {
        const p = top().point;
        const kNode = p5.strandsNode(k);
        const angle = kNode.mult(p.y);
        const c = sketch.cos(angle);
        const s = sketch.sin(angle);
        top().point = sketch.vec3(c.mult(p.x).sub(s.mult(p.z)), p.y, s.mult(p.x).add(c.mult(p.z)));
        const xzLen = sketch.length(sketch.vec2(p.x, p.z));
        const lipschitz = p5.strandsNode(1.0).add(sketch.abs(kNode).mult(xzLen));
        const prev = top().mod;
        top().mod = d => {
          const corrected = d.div(lipschitz);
          return prev ? prev(corrected) : corrected;
        };
      },
      bend(k) {
        const p = top().point;
        const kNode = p5.strandsNode(k);
        const angle = kNode.mult(p.x);
        const c = sketch.cos(angle);
        const s = sketch.sin(angle);
        top().point = sketch.vec3(c.mult(p.x).sub(s.mult(p.y)), s.mult(p.x).add(c.mult(p.y)), p.z);
        const lipschitz = p5.strandsNode(1.0).add(sketch.abs(kNode).mult(sketch.length(p)));
        const prev = top().mod;
        top().mod = d => {
          const corrected = d.div(lipschitz);
          return prev ? prev(corrected) : corrected;
        };
      },

      rotateX(a) {
        const p = top().point;
        const c = sketch.cos(a);
        const s = sketch.sin(a);
        top().point = sketch.vec3(p.x, p.y.mult(c).add(p.z.mult(s)), p.z.mult(c).sub(p.y.mult(s)));
      },
      rotateY(a) {
        const p = top().point;
        const c = sketch.cos(a);
        const s = sketch.sin(a);
        top().point = sketch.vec3(p.x.mult(c).sub(p.z.mult(s)), p.y, p.x.mult(s).add(p.z.mult(c)));
      },
      rotateZ(a) {
        const p = top().point;
        const c = sketch.cos(a);
        const s = sketch.sin(a);
        top().point = sketch.vec3(p.x.mult(c).add(p.y.mult(s)), p.y.mult(c).sub(p.x.mult(s)), p.z);
      },

      ////////////////////////
      // BOOLEAN OPS
      ////////////////////////
      union() {
        top().op = 'union';
        top().opK = 0;
      },
      subtract() {
        top().op = 'subtract';
        top().opK = 0;
      },
      intersect() {
        top().op = 'intersect';
        top().opK = 0;
      },
      smoothUnion(k) {
        top().op = 'smoothUnion';
        top().opK = k;
      },
      smoothSubtract(k) {
        top().op = 'smoothSubtract';
        top().opK = k;
      },
      smoothIntersect(k) {
        top().op = 'smoothIntersect';
        top().opK = k;
      },

      ////////////////////////
      // DISTANCE MODIFIERS
      ////////////////////////
      round(r) {
        const prev = top().mod;
        top().mod = d => (prev ? prev(d) : d).sub(p5.strandsNode(r));
      },
      onion(t) {
        const prev = top().mod;
        top().mod = d => sketch.abs(prev ? prev(d) : d).sub(p5.strandsNode(t));
      },

      ////////////////////////
      // MATERIALS
      ////////////////////////
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
      shininess(v) {
        top().mat.shininess = p5.strandsNode(v);
      },
      metalness(v) {
        top().mat.metalness = p5.strandsNode(v);
      },

      _addShape(d) {
        const frame = top();
        if (frame.scale !== 1) d = d.mult(p5.strandsNode(frame.scale));
        if (frame.mod !== null) d = frame.mod(d);
        const m = frame.mat;
        result = combine(result, d, {
          color: m.color ?? defaults.color,
          ambient: m.ambient ?? defaults.ambient,
          specular: m.specular ?? defaults.specular,
          emissive: m.emissive ?? defaults.emissive,
          shininess: m.shininess ?? defaults.shininess,
          metalness: m.metalness ?? defaults.metalness,
        });
      },

      ////////////////////////
      // PRIMITIVES
      ////////////////////////
      sphere(r) {
        this._addShape(sketch.length(top().point).sub(r));
      },
      box(width, height, depth) {
        if (height === undefined) height = width;
        if (depth === undefined) depth = width;
        const p = top().point;
        const b = sketch.vec3(width / 2, height / 2, depth / 2);
        const q = sketch.abs(p).sub(b);
        this._addShape(
          sketch.length(sketch.max(q, 0.0)).add(sketch.min(sketch.max(q.x, sketch.max(q.y, q.z)), 0.0))
        );
      },
      roundBox(width, height, depth, r) {
        if (height === undefined) height = width;
        if (depth === undefined) depth = width;
        const p = top().point;
        const b = sketch.vec3(width / 2 - r, height / 2 - r, depth / 2 - r);
        const q = sketch.abs(p).sub(b);
        this._addShape(
          sketch.length(sketch.max(q, 0.0)).add(sketch.min(sketch.max(q.x, sketch.max(q.y, q.z)), 0.0)).sub(p5.strandsNode(r))
        );
      },
      boxFrame(width, height, depth, e) {
        if (height === undefined) height = width;
        if (depth === undefined) depth = width;
        const pv = sketch.abs(top().point).sub(sketch.vec3(width / 2, height / 2, depth / 2));
        const ev = p5.strandsNode(e);
        const q = sketch.abs(pv.add(ev)).sub(ev);
        const d1 = sketch.length(sketch.max(sketch.vec3(pv.x, q.y, q.z), 0.0)).add(sketch.min(sketch.max(pv.x, sketch.max(q.y, q.z)), 0.0));
        const d2 = sketch.length(sketch.max(sketch.vec3(q.x, pv.y, q.z), 0.0)).add(sketch.min(sketch.max(q.x, sketch.max(pv.y, q.z)), 0.0));
        const d3 = sketch.length(sketch.max(sketch.vec3(q.x, q.y, pv.z), 0.0)).add(sketch.min(sketch.max(q.x, sketch.max(q.y, pv.z)), 0.0));
        this._addShape(sketch.min(sketch.min(d1, d2), d3));
      },
      cylinder(radius, height) {
        const p = top().point;
        const xzLen = sketch.length(sketch.vec2(p.x, p.z));
        const d2 = sketch.vec2(xzLen.sub(radius), sketch.abs(p.y).sub(height / 2));
        this._addShape(sketch.min(sketch.max(d2.x, d2.y), 0.0).add(sketch.length(sketch.max(d2, 0.0))));
      },
      capsule(h, r) {
        const p = top().point;
        const py = p.y.sub(sketch.clamp(p.y, 0.0, h));
        this._addShape(sketch.length(sketch.vec3(p.x, py, p.z)).sub(p5.strandsNode(r)));
      },
      torus(radius, tubeRadius) {
        const p = top().point;
        const xzLen = sketch.length(sketch.vec2(p.x, p.z));
        this._addShape(sketch.length(sketch.vec2(xzLen.sub(radius), p.y)).sub(tubeRadius));
      },
      plane(nx, ny, nz, h) {
        const p = top().point;
        this._addShape(
          p5.strandsNode(nx).mult(p.x).add(p5.strandsNode(ny).mult(p.y)).add(p5.strandsNode(nz).mult(p.z)).add(p5.strandsNode(h))
        );
      },
      ellipsoid(rx, ry, rz) {
        const p = top().point;
        const r = sketch.vec3(rx, ry, rz);
        const k0 = sketch.length(p.div(r));
        const k1 = sketch.length(p.div(r.mult(r)));
        this._addShape(k0.mult(k0.sub(p5.strandsNode(1.0))).div(k1));
      },
      octahedron(s) {
        const p = sketch.abs(top().point);
        this._addShape(p.x.add(p.y).add(p.z).sub(p5.strandsNode(s)).mult(p5.strandsNode(0.57735027)));
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
        sketch.noStroke();

        const renderer = sketch._renderer;
        const mvMatrix = renderer.uMVMatrix.copy();
        mvMatrix.invert(mvMatrix);
        shader.setUniform('uInverseModelViewMatrix', mvMatrix.mat4);

        const pMatrix = renderer.uPMatrix.copy();
        pMatrix.invert(pMatrix);
        shader.setUniform('uInverseProjectionMatrix', pMatrix.mat4);

        sketch.drawingContext.enable(sketch.drawingContext.CULL_FACE);
        sketch.drawingContext.cullFace(sketch.drawingContext.FRONT);

        if (typeof radiusOrCallback === 'number') {
          const r = radiusOrCallback;
          shader.setUniform('uSDFMaxDist', r * 2.0);
          sketch.sphere(r);
        } else {
          shader.setUniform('uSDFMaxDist', 1000);
          radiusOrCallback();
        }

        sketch.drawingContext.disable(sketch.drawingContext.CULL_FACE);
        sketch.pop();
      },
    };
  };
}

if (typeof p5 !== 'undefined') {
  p5.registerAddon(sdf);
}
