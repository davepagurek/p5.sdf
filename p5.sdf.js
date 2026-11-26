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
  const glslFragPrefix = `
    struct SDFResult {
      float sdfDist;
      vec4 sdfColor;
      vec3 sdfAmbient;
      vec3 sdfSpecular;
      vec3 sdfEmissive;
      float sdfShininess;
      float sdfMetalness;
    };
    uniform mat4 uProjectionMatrix;
    uniform mat3 uNormalMatrix;
  `;

  const glslBaseSDFShader = (sketch) => {
    const base = sketch.baseMaterialShader();
    return new p5.Shader(
      base._renderer,
      base._vertSrc,
      injectAfterLastPrecision(base._fragSrc, glslFragPrefix),
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
          'SDFResult sdfScene': `(SDFResult result, vec3 sdfPoint, bool sdfComputeMaterial) {
            result.sdfDist = length(sdfPoint) - 1.0;
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
            defaultResult.sdfColor = inputs.color;
            defaultResult.sdfAmbient = inputs.ambientMaterial;
            defaultResult.sdfSpecular = inputs.specularMaterial;
            defaultResult.sdfEmissive = inputs.emissiveMaterial;
            defaultResult.sdfShininess = inputs.shininess;
            defaultResult.sdfMetalness = inputs.metalness;

            float t = 0.0;
            bool hit = false;
            for (int i = 0; i < 256; i++) {
              vec3 viewPos = rayOrigin + t * rayDir;
              vec3 sdfPos = (uInverseModelViewMatrix * vec4(viewPos, 1.0)).xyz;
              defaultResult.sdfDist = 1e10;
              float d = HOOK_sdfScene(defaultResult, sdfPos, false).sdfDist;
              if (d < 0.001) { hit = true; break; }
              if (t > uSDFMaxDist) break;
              t += d;
            }

            if (!hit) discard;

            vec3 hitViewPos = rayOrigin + t * rayDir;
            vec3 hitSdfPos = (uInverseModelViewMatrix * vec4(hitViewPos, 1.0)).xyz;

            defaultResult.sdfDist = 1e10;
            SDFResult hitResult = HOOK_sdfScene(defaultResult, hitSdfPos, true);

            float eps = 0.001;
            vec2 k = vec2(1.0, -1.0);
            defaultResult.sdfDist = 1e10;
            vec3 sdfNormal = normalize(
              k.xyy * HOOK_sdfScene(defaultResult, hitSdfPos + eps * k.xyy, false).sdfDist +
              k.yyx * HOOK_sdfScene(defaultResult, hitSdfPos + eps * k.yyx, false).sdfDist +
              k.yxy * HOOK_sdfScene(defaultResult, hitSdfPos + eps * k.yxy, false).sdfDist +
              k.xxx * HOOK_sdfScene(defaultResult, hitSdfPos + eps * k.xxx, false).sdfDist
            );

            _sdfHitViewPos = hitViewPos;
            _sdfNormal = normalize(uNormalMatrix * sdfNormal);
            _sdfShininess = hitResult.sdfShininess;
            _sdfMetalness = hitResult.sdfMetalness;

            inputs.normal = _sdfNormal;
            inputs.color = hitResult.sdfColor;
            inputs.shininess = hitResult.sdfShininess;
            inputs.metalness = hitResult.sdfMetalness;
            inputs.ambientMaterial = hitResult.sdfAmbient;
            inputs.specularMaterial = hitResult.sdfSpecular;
            inputs.emissiveMaterial = hitResult.sdfEmissive;

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
  };

  const wgslFragPrefix = `
    struct SDFResult {
      sdfDist: f32,
      sdfColor: vec4<f32>,
      sdfAmbient: vec3<f32>,
      sdfSpecular: vec3<f32>,
      sdfEmissive: vec3<f32>,
      sdfShininess: f32,
      sdfMetalness: f32,
    };
    struct SDFFragmentOutput {
      @location(0) color: vec4<f32>,
      @builtin(frag_depth) depth: f32,
    };
  `;

  // In GLSL the fragment depth is a global, gl_FragDepth, so a hook can set it.
  // WGSL has no such global: the fragment output is whatever the entry point
  // returns, and p5's material shader returns only a color. The raymarched
  // surface is not where the bounding sphere is, so depth has to come from the
  // ray hit, which means the entry point itself is rewritten to also return a
  // depth rather than just adding hooks.
  // TODO: Make this more supported in p5 core, for example a hook or option for
  // writing fragment depth, so addons don't have to rewrite the entry point
  const patchWGSLFragment = (src) => {
    const signature = '-> @location(0) vec4<f32> {';
    const outputStatement = 'return outColor;';
    if (!src.includes('@fragment') || !src.includes(signature) || !src.includes(outputStatement)) {
      throw new Error('p5.sdf could not patch the WebGPU material shader. This version of p5 may have changed it.');
    }
    // Hooks only receive their own arguments, so the interpolated position of
    // the bounding sphere is stashed for the ray origin
    return src
      .replace('@fragment', `${wgslFragPrefix}\n@fragment`)
      .replace(signature, '-> SDFFragmentOutput {\n  _sdfProxyViewPos = input.vViewPosition;')
      .replace(outputStatement, 'return SDFFragmentOutput(outColor, _sdfDepth);');
  };

  const wgslBaseSDFShader = (sketch) => {
    const base = sketch.baseMaterialShader();
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    return new p5.Shader(
      base._renderer,
      base._vertSrc,
      patchWGSLFragment(base._fragSrc),
      {
        declarations: `
          var<private> _sdfProxyViewPos: vec3<f32>;
          var<private> _sdfHitViewPos: vec3<f32>;
          var<private> _sdfNormal: vec3<f32>;
          var<private> _sdfShininess: f32;
          var<private> _sdfMetalness: f32;
          var<private> _sdfDepth: f32;
        `,
        uniforms: {
          ...base.hooks.uniforms,
          'uInverseModelViewMatrix: mat4x4<f32>': identity,
          'uInverseProjectionMatrix: mat4x4<f32>': identity,
          'uSDFMaxDist: f32': 0,
          'uSDFViewport: vec4<f32>': [0, 0, 1, 1],
        },
        vertex: {
          ...base.hooks.vertex,
        },
        fragment: {
          'SDFResult sdfScene': `(result: SDFResult, sdfPoint: vec3<f32>, sdfComputeMaterial: bool) {
            var out = result;
            out.sdfDist = length(sdfPoint) - 1.0;
            return out;
          }`,
          ...base.hooks.fragment,
          'Inputs getPixelInputs': `(inputs: Inputs) {
            var out = inputs;
            let size = hooks.uSDFViewport.zw;
            let ndc = vec2<f32>(
              _p5FragPos.x / size.x * 2.0 - 1.0,
              1.0 - _p5FragPos.y / size.y * 2.0
            );
            let near4 = hooks.uInverseProjectionMatrix * vec4<f32>(ndc, 0.0, 1.0);
            let far4 = hooks.uInverseProjectionMatrix * vec4<f32>(ndc, 1.0, 1.0);
            let rayDir = normalize(far4.xyz / far4.w - near4.xyz / near4.w);
            let rayOrigin = _sdfProxyViewPos;

            var current = SDFResult(
              1e10,
              inputs.color,
              inputs.ambientMaterial,
              inputs.specularMaterial,
              inputs.emissiveMaterial,
              inputs.shininess,
              inputs.metalness
            );

            var t = 0.0;
            var hit = false;
            for (var i = 0; i < 256; i++) {
              let viewPos = rayOrigin + t * rayDir;
              let sdfPos = (hooks.uInverseModelViewMatrix * vec4<f32>(viewPos, 1.0)).xyz;
              current.sdfDist = 1e10;
              let d = HOOK_sdfScene(current, sdfPos, false, _p5FragPos).sdfDist;
              if (d < 0.001) {
                hit = true;
                break;
              }
              if (t > hooks.uSDFMaxDist) {
                break;
              }
              t += d;
            }

            if (!hit) {
              discard;
            }

            let hitViewPos = rayOrigin + t * rayDir;
            let hitSdfPos = (hooks.uInverseModelViewMatrix * vec4<f32>(hitViewPos, 1.0)).xyz;

            current.sdfDist = 1e10;
            let hitResult = HOOK_sdfScene(current, hitSdfPos, true, _p5FragPos);

            let eps = 0.001;
            let k = vec2<f32>(1.0, -1.0);
            current.sdfDist = 1e10;
            let sdfNormal = normalize(
              k.xyy * HOOK_sdfScene(current, hitSdfPos + eps * k.xyy, false, _p5FragPos).sdfDist +
              k.yyx * HOOK_sdfScene(current, hitSdfPos + eps * k.yyx, false, _p5FragPos).sdfDist +
              k.yxy * HOOK_sdfScene(current, hitSdfPos + eps * k.yxy, false, _p5FragPos).sdfDist +
              k.xxx * HOOK_sdfScene(current, hitSdfPos + eps * k.xxx, false, _p5FragPos).sdfDist
            );

            _sdfHitViewPos = hitViewPos;
            _sdfNormal = normalize(model.uNormalMatrix * sdfNormal);
            _sdfShininess = hitResult.sdfShininess;
            _sdfMetalness = hitResult.sdfMetalness;

            out.normal = _sdfNormal;
            out.color = hitResult.sdfColor;
            out.shininess = hitResult.sdfShininess;
            out.metalness = hitResult.sdfMetalness;
            out.ambientMaterial = hitResult.sdfAmbient;
            out.specularMaterial = hitResult.sdfSpecular;
            out.emissiveMaterial = hitResult.sdfEmissive;

            let clipPos = camera.uProjectionMatrix * vec4<f32>(hitViewPos, 1.0);
            _sdfDepth = clipPos.z / clipPos.w;

            return out;
          }`,
          'vec4f combineColors': `(components: ColorComponents) {
            let light = totalLight(_sdfHitViewPos, _sdfNormal, _sdfShininess, _sdfMetalness);
            var rgb = vec3<f32>(0.0);
            rgb += light.diffuse * components.baseColor;
            rgb += components.ambient * components.ambientColor;
            rgb += light.specular * components.specularColor;
            rgb += components.emissive;
            return vec4<f32>(rgb, components.opacity);
          }`,
        },
      }
    );
  };

  fn.baseSDFShader = function() {
    const isWebGPU = this.rendererType === 'webgpu';
    const cacheKey = isWebGPU ? '_baseSDFShaderWebGPU' : '_baseSDFShader';
    if (!this[cacheKey]) {
      this[cacheKey] = isWebGPU ? wgslBaseSDFShader(this) : glslBaseSDFShader(this);
    }
    return this[cacheKey];
  };

  const OP = {
    union: 0,
    subtract: 1,
    intersect: 2,
    smoothUnion: 3,
    smoothSubtract: 4,
    smoothIntersect: 5,
  };

  const node = v => p5.strandsNode(v);
  const neg = v => (v?.isStrandsNode ? v.mult(-1) : -v);
  const select = (cond, ifTrue, ifFalse) => p5.strandsTernary(cond, ifTrue, ifFalse);

  // Some state is bookkeeping the user never sets directly: the boolean op, the
  // flag for whether a shape has been drawn yet, and the scale that starts at 1.
  // Their values are plain constants unless a loop or if merged different values
  // into them. Strands nodes don't expose their value, so we remember which node
  // ids we created from a constant. addShape can then emit only the math that
  // applies, the way branching in plain JS used to, and fall back to selecting
  // at runtime when the id is not one we recorded (a merged value)
  const constant = (config, value) => {
    const n = node(value);
    config.constants.set(n.id, value);
    return n;
  };
  const constantValue = (config, n) => config.constants.get(n.id);

  // registerStrandsState splits an addon instance's state into scoped fields, which
  // push() and pop() save and restore, and global fields, which keep their
  // values across pop(). Update methods must return both groups, so this applies
  // a patch to the scoped fields only and passes the global fields through
  // unchanged
  const withScoped = (state, patch) => ({
    scoped: { ...state.scoped, ...patch },
    global: state.global,
  });

  // Shapes are evaluated in object space, so each step applies the inverse of
  // the transform the user asked for
  const movePoint = (sketch, state, buildStep) => {
    const step = buildStep(sketch.transform3D());
    return withScoped(state, {
      point: sketch.transformPoint(step, state.scoped.point),
    });
  };

  const isVector = v => v && typeof v === 'object' && !v.isStrandsNode && !Array.isArray(v) && 'x' in v;

  const rotateAxis = (name) => function(state, config, angle) {
    return movePoint(this, state, identity => this[name](identity, neg(angle)));
  };

  const toVec3 = (sketch, axis) => {
    if (axis?.isStrandsNode) {
      return axis;
    }
    if (Array.isArray(axis)) {
      return sketch.vec3(axis[0], axis[1], axis[2]);
    }
    return sketch.vec3(axis.x, axis.y, axis.z);
  };

  // A shear stretches space, so distances measured in the sheared space can be
  // too large and the raymarcher could step through the surface. Dividing by the
  // most the shear can stretch a vector (the same idea as the twist and bend
  // corrections) keeps every step safe
  const shear = (name) => function(state, config, angle) {
    const k = this.tan(node(angle));
    const norm = this.abs(k).add(this.sqrt(k.mult(k).add(4.0))).mult(0.5);
    const moved = movePoint(this, state, identity => this[name](identity, neg(angle)));
    return withScoped(moved, { distScale: state.scoped.distScale.div(norm) });
  };

  const smoothBlendFactor = (sketch, a, b, k) =>
    sketch.clamp(node(0.5).add(node(0.5).mult(b.sub(a).div(k))), 0.0, 1.0);

  const MATERIAL_FIELDS = ['color', 'ambient', 'specular', 'emissive', 'shininess', 'metalness'];

  // The hook's properties become globals for the length of a build, so its
  // fields can't be named dist, color or point without hiding p5's own functions
  const hookField = name => `sdf${name[0].toUpperCase()}${name.slice(1)}`;

  // The weight is how much of the existing material survives, which lets every
  // boolean op share one material mix
  const addShape = (sketch, state, config, unscaledDist) => {
    const { scoped, global } = state;
    const d = constantValue(config, scoped.distScale) === 1
      ? unscaledDist
      : unscaledDist.mult(scoped.distScale);
    const e = global.dist;
    const k = node(scoped.opK);
    const negD = d.mult(-1);

    const opResults = {
      [OP.union]: () => ({ dist: sketch.min(e, d), weight: sketch.step(e, d) }),
      [OP.subtract]: () => ({ dist: sketch.max(e, negD), weight: node(1.0) }),
      [OP.intersect]: () => ({ dist: sketch.max(e, d), weight: sketch.step(d, e) }),
      [OP.smoothUnion]: () => {
        const blend = smoothBlendFactor(sketch, e, d, k);
        const correction = blend.mult(node(1.0).sub(blend));
        return { dist: sketch.mix(d, e, blend).sub(k.mult(correction)), weight: blend };
      },
      [OP.smoothSubtract]: () => {
        const blend = smoothBlendFactor(sketch, e, negD, k);
        const correction = blend.mult(node(1.0).sub(blend));
        return { dist: sketch.mix(e, negD, blend).add(k.mult(correction)), weight: node(1.0) };
      },
      [OP.smoothIntersect]: () => {
        const blend = smoothBlendFactor(sketch, e, d, k);
        const correction = blend.mult(node(1.0).sub(blend));
        return { dist: sketch.mix(e, d, blend).add(k.mult(correction)), weight: node(1.0).sub(blend) };
      },
    };

    const opCode = constantValue(config, scoped.op);
    const combineWithExisting = () => {
      if (opCode !== undefined) {
        return opResults[opCode]();
      }
      const [first, ...rest] = Object.entries(opResults).map(([code, build]) => ({
        code: Number(code),
        ...build(),
      }));
      return rest.reduce((chosen, candidate) => {
        const isCandidate = scoped.op.equalTo(candidate.code);
        return {
          dist: select(isCandidate, candidate.dist, chosen.dist),
          weight: select(isCandidate, candidate.weight, chosen.weight),
        };
      }, first);
    };

    let dist = d;
    let weight = null;
    const shapeDrawn = constantValue(config, global.hasShape);
    if (shapeDrawn !== 0) {
      const combined = combineWithExisting();
      if (shapeDrawn === 1) {
        dist = combined.dist;
        weight = combined.weight;
      } else {
        const hasShape = global.hasShape.greaterThan(0.5);
        dist = select(hasShape, combined.dist, d);
        weight = select(hasShape, combined.weight, node(0.0));
      }
    }

    const next = { dist, hasShape: constant(config, 1.0) };
    for (const field of MATERIAL_FIELDS) {
      const merged = weight === null
        ? scoped[field]
        : sketch.mix(scoped[field], global[field], weight);
      next[field] = select(config.computeMaterial, merged, global[field]);
    }
    return { scoped, global: next };
  };

  const boxDist = (sketch, p, width, height, depth) => {
    const b = sketch.vec3(
      node(width).mult(0.5),
      node(height).mult(0.5),
      node(depth).mult(0.5)
    );
    const q = sketch.abs(p).sub(b);
    return sketch.length(sketch.max(q, 0.0)).add(sketch.min(sketch.max(q.x, sketch.max(q.y, q.z)), 0.0));
  };

  const shape = (compute) => function(state, config, ...args) {
    return addShape(this, state, config, compute(this, state.scoped.point, ...args));
  };

  const setOp = (code) => function(state, config, k = 0) {
    return withScoped(state, { op: constant(config, code), opK: node(k) });
  };

  const colorRgb = (sketch, args) => {
    const c = sketch.color(...args);
    return sketch.vec3(c.r, c.g, c.b);
  };

  // A group is a push() and pop() pair that also scopes a filter on distance.
  // Shapes inside start from an empty result so the filter only sees them, then
  // the filtered result is merged into the outer one with the boolean op that
  // was in effect when the group started. The body changes state through the
  // addon instance while it runs, so the state returned here is built from what
  // the body left behind instead of from the snapshot this method was called
  // with.
  // The addon instance is the object distanceFunction() returns (the sdf in
  // sdf.sphere(10)), and its methods are the ones defined below. State methods
  // only receive (state, config, ...args) and not the addon instance, so it
  // comes from config.instanceRef, which fn.distanceFunction fills in
  const group = (filter) => function(state, config, amount, body) {
    const instance = config.instanceRef.current;
    const { op, opK } = state.scoped;
    this.push();
    instance._beginGroup();
    body();
    const inner = instance._globalState();
    this.pop();

    if (constantValue(config, inner.hasShape) === 0) {
      return { scoped: state.scoped, global: state.global };
    }
    const groupAsShape = { distScale: constant(config, 1.0), op, opK };
    for (const field of MATERIAL_FIELDS) {
      groupAsShape[field] = inner[field];
    }
    const merged = addShape(
      this,
      { scoped: groupAsShape, global: state.global },
      config,
      filter(this, inner.dist, amount)
    );
    return { scoped: state.scoped, global: merged.global };
  };

  const createInstance = p5.registerStrandsState('distanceFunction', {
    init(hook, instanceRef) {
      const config = {
        hook,
        instanceRef,
        computeMaterial: hook.sdfComputeMaterial,
        constants: new Map(),
      };
      const defaults = {};
      for (const field of MATERIAL_FIELDS) {
        defaults[field] = hook[hookField(field)];
      }
      return {
        config,
        state: {
          scoped: {
            point: hook.sdfPoint,
            distScale: constant(config, 1.0),
            op: constant(config, OP.union),
            opK: node(0.0),
            ...defaults,
          },
          global: {
            dist: node(1e10),
            hasShape: constant(config, 0.0),
            ...defaults,
          },
        },
      };
    },

    update: {
      _beginGroup(state, config) {
        return {
          scoped: state.scoped,
          global: {
            ...state.global,
            dist: constant(config, 1e10),
            hasShape: constant(config, 0.0),
          },
        };
      },

      ////////////////////////
      // TRANSFORMS
      ////////////////////////
      translate(state, config, x, y = 0, z = 0) {
        if (isVector(x)) {
          ({ x, y, z } = x);
        }
        return movePoint(this, state, identity =>
          this.translate(identity, neg(x), neg(y), neg(z))
        );
      },
      scale(state, config, x, y, z) {
        if (isVector(x)) {
          ({ x, y, z } = x);
        } else if (Array.isArray(x)) {
          [x, y, z = 1] = x;
        }
        if (y === undefined) {
          return withScoped(state, {
            point: state.scoped.point.div(node(x)),
            distScale: state.scoped.distScale.mult(node(x)),
          });
        }
        // Per-axis scaling stretches distances by different amounts, so the
        // smallest factor is the one that keeps every raymarch step safe
        const factors = this.vec3(x, y, z === undefined ? 1 : z);
        const smallest = this.min(this.min(factors.x, factors.y), factors.z);
        return withScoped(state, {
          point: state.scoped.point.div(factors),
          distScale: state.scoped.distScale.mult(smallest),
        });
      },
      rotate(state, config, angle, axis) {
        return movePoint(this, state, identity =>
          axis === undefined
            ? this.rotateZ(identity, neg(angle))
            : this.rotateAxisAngle(identity, toVec3(this, axis), neg(angle))
        );
      },
      rotateX: rotateAxis('rotateX'),
      rotateY: rotateAxis('rotateY'),
      rotateZ: rotateAxis('rotateZ'),
      shearX: shear('shearX'),
      shearY: shear('shearY'),
      mirror(state, config, axis) {
        const p = state.scoped.point;
        const point = {
          x: () => this.vec3(this.abs(p.x), p.y, p.z),
          y: () => this.vec3(p.x, this.abs(p.y), p.z),
          z: () => this.vec3(p.x, p.y, this.abs(p.z)),
        }[axis]?.() ?? p;
        return withScoped(state, { point });
      },
      elongate(state, config, hx, hy, hz) {
        const p = state.scoped.point;
        const h = this.vec3(hx, hy, hz);
        return withScoped(state, {
          point: p.sub(this.clamp(p, h.mult(-1), h)),
        });
      },
      twist(state, config, k) {
        const p = state.scoped.point;
        const kNode = node(k);
        const angle = kNode.mult(p.y);
        const c = this.cos(angle);
        const s = this.sin(angle);
        const xzLen = this.length(this.vec2(p.x, p.z));
        const lipschitz = node(1.0).add(this.abs(kNode).mult(xzLen));
        return withScoped(state, {
          point: this.vec3(c.mult(p.x).sub(s.mult(p.z)), p.y, s.mult(p.x).add(c.mult(p.z))),
          distScale: state.scoped.distScale.div(lipschitz),
        });
      },
      bend(state, config, k) {
        const p = state.scoped.point;
        const kNode = node(k);
        const angle = kNode.mult(p.x);
        const c = this.cos(angle);
        const s = this.sin(angle);
        const lipschitz = node(1.0).add(this.abs(kNode).mult(this.length(p)));
        return withScoped(state, {
          point: this.vec3(c.mult(p.x).sub(s.mult(p.y)), s.mult(p.x).add(c.mult(p.y)), p.z),
          distScale: state.scoped.distScale.div(lipschitz),
        });
      },

      ////////////////////////
      // BOOLEAN OPS
      ////////////////////////
      union: setOp(OP.union),
      subtract: setOp(OP.subtract),
      intersect: setOp(OP.intersect),
      smoothUnion: setOp(OP.smoothUnion),
      smoothSubtract: setOp(OP.smoothSubtract),
      smoothIntersect: setOp(OP.smoothIntersect),

      ////////////////////////
      // MATERIALS
      ////////////////////////
      fill(state, config, ...args) {
        const c = this.color(...args);
        return withScoped(state, {
          color: c,
          ambient: this.vec3(c.r, c.g, c.b),
        });
      },
      ambientMaterial(state, config, ...args) {
        return withScoped(state, { ambient: colorRgb(this, args) });
      },
      specularMaterial(state, config, ...args) {
        return withScoped(state, { specular: colorRgb(this, args) });
      },
      emissiveMaterial(state, config, ...args) {
        return withScoped(state, { emissive: colorRgb(this, args) });
      },
      shininess(state, config, v) {
        return withScoped(state, { shininess: node(v) });
      },
      metalness(state, config, v) {
        return withScoped(state, { metalness: node(v) });
      },

      ////////////////////////
      // DISTANCE MODIFIERS
      ////////////////////////
      rounded: group((sketch, dist, radius) => dist.sub(node(radius))),
      onion: group((sketch, dist, thickness) => sketch.abs(dist).sub(node(thickness))),

      ////////////////////////
      // PRIMITIVES
      ////////////////////////
      sphere: shape((sketch, p, r = 50) => sketch.length(p).sub(r)),
      box: shape((sketch, p, width = 50, height = width, depth = height) => boxDist(sketch, p, width, height, depth)),
      roundBox: shape((sketch, p, width, height = width, depth = width, r) => {
        const rNode = node(r);
        const b = sketch.vec3(
          node(width).mult(0.5).sub(rNode),
          node(height).mult(0.5).sub(rNode),
          node(depth).mult(0.5).sub(rNode)
        );
        const q = sketch.abs(p).sub(b);
        return sketch.length(sketch.max(q, 0.0)).add(sketch.min(sketch.max(q.x, sketch.max(q.y, q.z)), 0.0)).sub(rNode);
      }),
      boxFrame: shape((sketch, p, width, height = width, depth = width, e) => {
        const pv = sketch.abs(p).sub(sketch.vec3(
          node(width).mult(0.5),
          node(height).mult(0.5),
          node(depth).mult(0.5)
        ));
        const ev = node(e);
        const q = sketch.abs(pv.add(ev)).sub(ev);
        const d1 = sketch.length(sketch.max(sketch.vec3(pv.x, q.y, q.z), 0.0)).add(sketch.min(sketch.max(pv.x, sketch.max(q.y, q.z)), 0.0));
        const d2 = sketch.length(sketch.max(sketch.vec3(q.x, pv.y, q.z), 0.0)).add(sketch.min(sketch.max(q.x, sketch.max(pv.y, q.z)), 0.0));
        const d3 = sketch.length(sketch.max(sketch.vec3(q.x, q.y, pv.z), 0.0)).add(sketch.min(sketch.max(q.x, sketch.max(q.y, pv.z)), 0.0));
        return sketch.min(sketch.min(d1, d2), d3);
      }),
      cylinder: shape((sketch, p, radius = 50, height = radius) => {
        const xzLen = sketch.length(sketch.vec2(p.x, p.z));
        const d2 = sketch.vec2(
          xzLen.sub(node(radius)),
          sketch.abs(p.y).sub(node(height).mult(0.5))
        );
        return sketch.min(sketch.max(d2.x, d2.y), 0.0).add(sketch.length(sketch.max(d2, 0.0)));
      }),
      capsule: shape((sketch, p, h, r) => {
        const py = p.y.sub(sketch.clamp(p.y, 0.0, h));
        return sketch.length(sketch.vec3(p.x, py, p.z)).sub(node(r));
      }),
      torus: shape((sketch, p, radius = 50, tubeRadius = 10) => {
        const xzLen = sketch.length(sketch.vec2(p.x, p.z));
        return sketch.length(sketch.vec2(xzLen.sub(radius), p.y)).sub(tubeRadius);
      }),
      plane: shape((sketch, p, width = 50, height = width) => boxDist(sketch, p, width, height, 1)),
      infinitePlane: shape((sketch, p, nx, ny, nz, h) =>
        node(nx).mult(p.x).add(node(ny).mult(p.y)).add(node(nz).mult(p.z)).add(node(h))
      ),
      ellipsoid: shape((sketch, p, rx = 50, ry = rx, rz = rx) => {
        const r = sketch.vec3(rx, ry, rz);
        const k0 = sketch.length(p.div(r));
        const k1 = sketch.length(p.div(r.mult(r)));
        return k0.mult(k0.sub(node(1.0))).div(k1);
      }),
      cone: shape((sketch, p, radius = 50, height = radius) => {
        const r = node(radius);
        const h = node(height).mult(0.5);
        const qx = sketch.length(sketch.vec2(p.x, p.z));
        const qy = p.y;
        const baseR = r.mult(sketch.step(qy, 0.0));
        const cax = qx.sub(sketch.min(qx, baseR));
        const cay = sketch.abs(qy).sub(h);
        const t = sketch.clamp(
          qx.mult(r).add(h.mult(2.0).mult(h.sub(qy))).div(r.mult(r).add(h.mult(h).mult(4.0))),
          0.0,
          1.0
        );
        const cbx = qx.sub(r.mult(t));
        const cby = qy.sub(h).add(h.mult(2.0).mult(t));
        const inside = node(1.0).sub(sketch.step(0.0, cbx)).mult(node(1.0).sub(sketch.step(0.0, cay)));
        const sign = node(1.0).sub(inside.mult(2.0));
        const d2 = sketch.min(cax.mult(cax).add(cay.mult(cay)), cbx.mult(cbx).add(cby.mult(cby)));
        return sign.mult(sketch.sqrt(d2));
      }),
      octahedron: shape((sketch, p, s) => {
        const q = sketch.abs(p);
        return q.x.add(q.y).add(q.z).sub(node(s)).mult(node(0.57735027));
      }),
    },

    read: {
      _globalState(state) {
        return state.global;
      },

      _apply(state, config) {
        const { hook } = config;
        hook.sdfDist = state.global.dist;
        for (const field of MATERIAL_FIELDS) {
          hook[hookField(field)] = state.global[field];
        }
      },
    },
  });

  // The addon instance is the object this function returns (the sdf in
  // const sdf = distanceFunction(sdfScene)). registerStrandsState hands the
  // arguments it is called with to init, and hands the config that init returns
  // to every update and read method. That is how the finished addon instance
  // reaches the group methods: it is passed in as instanceRef, stored on the
  // config, and read back out later. The addon instance doesn't exist until the
  // factory returns, so current is filled in afterwards. It is set once per
  // addon instance and never changes, so groups don't need to reset it
  const isTransformMatrix = value =>
    value?.isStrandsNode && value.typeInfo().baseType === 'mat';

  // p5.strands has its own translate, scale, rotate, rotateX, rotateY, rotateZ,
  // shearX and shearY that take a transform matrix as the first argument.
  // Installing the addon instance globally hides them for the length of a
  // build, so each of these names hands off to the strands version when it is
  // given a matrix and uses the SDF version otherwise. That also means the
  // methods above can call this.translate(identity, ...) and get the strands
  // version, and the strands transform helpers stay usable inside a build
  const SHARED_TRANSFORM_NAMES = [
    'translate', 'scale', 'rotate', 'rotateX', 'rotateY', 'rotateZ', 'shearX', 'shearY',
  ];

  fn.distanceFunction = function(hook) {
    const sketch = this;
    const instanceRef = {};
    const instance = createInstance.call(sketch, hook, instanceRef);
    instanceRef.current = instance;

    for (const name of SHARED_TRANSFORM_NAMES) {
      const strandsVersion = sketch[name];
      const sdfVersion = instance[name];
      instance[name] = function(...args) {
        if (isTransformMatrix(args[0])) {
          return strandsVersion.apply(sketch, args);
        }
        return sdfVersion.apply(this, args);
      };
    }
    return instance;
  };

  fn.buildSDF = function(callback) {
    const sketch = this;
    let resultApplied = false;
    // The callback goes straight to modify() because modify() re-evaluates its
    // source, so a wrapper function would hide the user's code and the
    // variables it closes over. Writing the result into the hook has to happen
    // right before the hook ends, so the hook's end() is wrapped for this build
    const shader = this.baseSDFShader().modify(callback, {}, {
      hook: 'sdfScene',
      globalInstance() {
        const hook = this.sdfScene;
        const instance = this.distanceFunction(hook);
        const end = hook.end;
        hook.end = function(...args) {
          hook.end = end;
          instance._apply();
          resultApplied = true;
          return end.apply(this, args);
        };
        return instance;
      },
    });
    if (!resultApplied) {
      throw new Error('p5.sdf could not write the distance function into the shader. This version of p5 may end hooks differently than p5.sdf expects.');
    }

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

        const isWebGPU = sketch.rendererType === 'webgpu';
        if (isWebGPU) {
          // This addon's WebGPU shader needs the canvas size in device pixels:
          // the GPU gives the fragment shader its position in device pixels
          // (@builtin(position)), and the shader uses the size to turn that
          // position into a ray. p5 provides a uViewport uniform to any shader
          // that declares one (Renderer3D._setGlobalUniforms), but the WebGL
          // renderer fills it in device pixels and the WebGPU renderer fills it
          // in CSS pixels, which would give wrong rays on high density screens.
          // So the addon declares its own uniform, which p5 never overwrites,
          // and sets it here in device pixels
          const density = sketch.pixelDensity();
          shader.setUniform('uSDFViewport', [0, 0, sketch.width * density, sketch.height * density]);
          // TODO: p5's WebGPU renderer has no face culling, so both faces of the
          // bounding shape are drawn and rays from the far faces just miss. Once
          // it can cull, cull the front faces here like the WebGL branch does
        } else {
          sketch.drawingContext.enable(sketch.drawingContext.CULL_FACE);
          sketch.drawingContext.cullFace(sketch.drawingContext.FRONT);
        }

        if (typeof radiusOrCallback === 'number') {
          const r = radiusOrCallback;
          shader.setUniform('uSDFMaxDist', r * 2.0);
          sketch.sphere(r);
        } else {
          shader.setUniform('uSDFMaxDist', 1000);
          radiusOrCallback();
        }

        if (!isWebGPU) {
          sketch.drawingContext.disable(sketch.drawingContext.CULL_FACE);
        }
        sketch.pop();
      },
    };
  };
}

if (typeof p5 !== 'undefined') {
  p5.registerAddon(sdf);
}
