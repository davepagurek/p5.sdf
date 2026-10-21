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

  const OPS = {
    union: 0,
    subtract: 1,
    intersect: 2,
    smoothUnion: 3,
    smoothSubtract: 4,
    smoothIntersect: 5,
  };

  const MATERIAL_FIELDS = ['color', 'ambient', 'specular', 'emissive', 'shininess', 'metalness'];

  // Scoped fields are restored by pop, global fields accumulate across it
  const withState = (state, scoped = {}, global = {}) => ({
    scoped: { ...state.scoped, ...scoped },
    global: { ...state.global, ...global },
  });

  // Distance modifiers are numeric fields rather than closures so they can be
  // restored by pop and merged across branches. Shapes are corrected by
  // `lip` first, then offset by `roundIn`, then (if `onion` is 1) shelled with `roundOut`
  const addShape = (sketch, state, config, d) => {
    const { scoped: s, global: g } = state;
    const one = p5.strandsNode(1.0);
    const half = p5.strandsNode(0.5);

    const corrected = d.mult(s.scale).div(s.lip).sub(s.roundIn);
    d = sketch.mix(corrected, sketch.abs(corrected).sub(s.roundOut), s.onion);

    // Guarded so unused smooth ops stay finite when they get multiplied by a zero weight
    const k = sketch.max(s.opK, 0.0001);
    const e = g.dist;
    const sminH = (a, b) => sketch.clamp(half.add(half.mult(b.sub(a).div(k))), 0.0, 1.0);
    const smoothTerm = h => k.mult(h).mult(one.sub(h));

    const negD = d.mult(-1.0);
    const hUnion = sminH(e, d);
    const hSubtract = sminH(e, negD);
    const hIntersect = sminH(e, d);

    // w=1 means the existing shape's material wins
    const candidates = [
      [OPS.union, sketch.min(e, d), sketch.step(e, d)],
      [OPS.subtract, sketch.max(e, negD), one],
      [OPS.intersect, sketch.max(e, d), sketch.step(d, e)],
      [OPS.smoothUnion, sketch.mix(d, e, hUnion).sub(smoothTerm(hUnion)), hUnion],
      [OPS.smoothSubtract, sketch.mix(e, negD, hSubtract).add(smoothTerm(hSubtract)), one],
      [OPS.smoothIntersect, sketch.mix(e, d, hIntersect).add(smoothTerm(hIntersect)), one.sub(hIntersect)],
    ];
    let combined = null;
    let w = null;
    for (const [code, candidateDist, candidateW] of candidates) {
      const active = one.sub(sketch.step(half, sketch.abs(s.op.sub(code))));
      combined = combined ? combined.add(active.mult(candidateDist)) : active.mult(candidateDist);
      w = w ? w.add(active.mult(candidateW)) : active.mult(candidateW);
    }

    // The first shape has nothing to combine with
    const existingW = w.mult(g.has);
    const global = { dist: sketch.mix(d, combined, g.has), has: one };
    for (const field of MATERIAL_FIELDS) {
      global[field] = p5.strandsTernary(
        config.computeMaterial,
        sketch.mix(s[field], g[field], existingW),
        g[field]
      );
    }
    return withState(state, {}, global);
  };

  const setOp = (state, op, opK = 0) =>
    withState(state, { op: p5.strandsNode(OPS[op]), opK: p5.strandsNode(opK) });

  const scaleLipschitz = (state, lipschitz) =>
    withState(state, { lip: state.scoped.lip.mult(lipschitz) });

  fn.createSDF = p5.registerStrandsState('createSDF', {
    init(hook, makeColor, config) {
      Object.assign(config, { hook, makeColor, computeMaterial: hook.computeMaterial });
      const zero = p5.strandsNode(0.0);
      const scoped = {
        point: hook.point,
        scale: p5.strandsNode(1.0),
        op: p5.strandsNode(OPS.union),
        opK: zero,
        lip: p5.strandsNode(1.0),
        roundIn: zero,
        roundOut: zero,
        onion: zero,
      };
      const global = { dist: p5.strandsNode(1e10), has: zero };
      for (const field of MATERIAL_FIELDS) {
        scoped[field] = hook[field];
        global[field] = hook[field];
      }
      return { config, state: { scoped, global } };
    },
    update: {
      push(state) {
        this.pushStrandsState();
        return withState(state);
      },
      // Restoring happens inside pop, so the stale snapshot has to be replaced
      pop(state, config) {
        this.popStrandsState();
        return { scoped: config.helper._scopedState(), global: state.global };
      },

      ////////////////////////
      // TRANSFORMS
      ////////////////////////
      translate(state, config, x, y, z) {
        return withState(state, { point: state.scoped.point.sub(this.vec3(x, y, z)) });
      },
      scale(state, config, s) {
        const sNode = p5.strandsNode(s);
        return withState(state, {
          point: state.scoped.point.div(sNode),
          scale: state.scoped.scale.mult(sNode),
        });
      },
      mirror(state, config, axis) {
        const p = state.scoped.point;
        if (axis === 'x') return withState(state, { point: this.vec3(this.abs(p.x), p.y, p.z) });
        if (axis === 'y') return withState(state, { point: this.vec3(p.x, this.abs(p.y), p.z) });
        if (axis === 'z') return withState(state, { point: this.vec3(p.x, p.y, this.abs(p.z)) });
        return withState(state);
      },
      elongate(state, config, hx, hy, hz) {
        const p = state.scoped.point;
        return withState(state, {
          point: p.sub(this.clamp(p, this.vec3(-hx, -hy, -hz), this.vec3(hx, hy, hz))),
        });
      },
      twist(state, config, k) {
        const p = state.scoped.point;
        const kNode = p5.strandsNode(k);
        const angle = kNode.mult(p.y);
        const c = this.cos(angle);
        const s = this.sin(angle);
        const xzLen = this.length(this.vec2(p.x, p.z));
        const next = withState(state, {
          point: this.vec3(c.mult(p.x).sub(s.mult(p.z)), p.y, s.mult(p.x).add(c.mult(p.z))),
        });
        return scaleLipschitz(next, p5.strandsNode(1.0).add(this.abs(kNode).mult(xzLen)));
      },
      bend(state, config, k) {
        const p = state.scoped.point;
        const kNode = p5.strandsNode(k);
        const angle = kNode.mult(p.x);
        const c = this.cos(angle);
        const s = this.sin(angle);
        const next = withState(state, {
          point: this.vec3(c.mult(p.x).sub(s.mult(p.y)), s.mult(p.x).add(c.mult(p.y)), p.z),
        });
        return scaleLipschitz(next, p5.strandsNode(1.0).add(this.abs(kNode).mult(this.length(p))));
      },

      rotateX(state, config, a) {
        const p = state.scoped.point;
        const c = this.cos(a);
        const s = this.sin(a);
        return withState(state, {
          point: this.vec3(p.x, p.y.mult(c).add(p.z.mult(s)), p.z.mult(c).sub(p.y.mult(s))),
        });
      },
      rotateY(state, config, a) {
        const p = state.scoped.point;
        const c = this.cos(a);
        const s = this.sin(a);
        return withState(state, {
          point: this.vec3(p.x.mult(c).sub(p.z.mult(s)), p.y, p.x.mult(s).add(p.z.mult(c))),
        });
      },
      rotateZ(state, config, a) {
        const p = state.scoped.point;
        const c = this.cos(a);
        const s = this.sin(a);
        return withState(state, {
          point: this.vec3(p.x.mult(c).add(p.y.mult(s)), p.y.mult(c).sub(p.x.mult(s)), p.z),
        });
      },

      ////////////////////////
      // BOOLEAN OPS
      ////////////////////////
      union: state => setOp(state, 'union'),
      subtract: state => setOp(state, 'subtract'),
      intersect: state => setOp(state, 'intersect'),
      smoothUnion: (state, config, k) => setOp(state, 'smoothUnion', k),
      smoothSubtract: (state, config, k) => setOp(state, 'smoothSubtract', k),
      smoothIntersect: (state, config, k) => setOp(state, 'smoothIntersect', k),

      ////////////////////////
      // DISTANCE MODIFIERS
      ////////////////////////
      round(state, config, r) {
        const { onion, roundIn, roundOut } = state.scoped;
        const rNode = p5.strandsNode(r);
        return withState(state, {
          roundIn: roundIn.add(p5.strandsNode(1.0).sub(onion).mult(rNode)),
          roundOut: roundOut.add(onion.mult(rNode)),
        });
      },
      onion(state, config, t) {
        return withState(state, {
          roundOut: state.scoped.roundOut.add(p5.strandsNode(t)),
          onion: p5.strandsNode(1.0),
        });
      },

      ////////////////////////
      // MATERIALS
      ////////////////////////
      fill(state, config, ...args) {
        // The hook's own `color` property shadows the sketch's during a global build
        const c = config.makeColor.call(this, ...args);
        return withState(state, { color: c, ambient: this.vec3(c.r, c.g, c.b) });
      },
      ambient(state, config, r, g, b) {
        return withState(state, { ambient: this.vec3(r / 255, g / 255, b / 255) });
      },
      specular(state, config, r, g, b) {
        return withState(state, { specular: this.vec3(r / 255, g / 255, b / 255) });
      },
      emissive(state, config, r, g, b) {
        return withState(state, { emissive: this.vec3(r / 255, g / 255, b / 255) });
      },
      shininess(state, config, v) {
        return withState(state, { shininess: p5.strandsNode(v) });
      },
      metalness(state, config, v) {
        return withState(state, { metalness: p5.strandsNode(v) });
      },

      ////////////////////////
      // PRIMITIVES
      ////////////////////////
      sphere(state, config, r) {
        return addShape(this, state, config, this.length(state.scoped.point).sub(r));
      },
      box(state, config, width, height = width, depth = width) {
        const p = state.scoped.point;
        const b = this.vec3(
          p5.strandsNode(width).mult(0.5),
          p5.strandsNode(height).mult(0.5),
          p5.strandsNode(depth).mult(0.5)
        );
        const q = this.abs(p).sub(b);
        return addShape(
          this, state, config,
          this.length(this.max(q, 0.0)).add(this.min(this.max(q.x, this.max(q.y, q.z)), 0.0))
        );
      },
      roundBox(state, config, width, height = width, depth = width, r) {
        const p = state.scoped.point;
        const rNode = p5.strandsNode(r);
        const b = this.vec3(
          p5.strandsNode(width).mult(0.5).sub(rNode),
          p5.strandsNode(height).mult(0.5).sub(rNode),
          p5.strandsNode(depth).mult(0.5).sub(rNode)
        );
        const q = this.abs(p).sub(b);
        return addShape(
          this, state, config,
          this.length(this.max(q, 0.0)).add(this.min(this.max(q.x, this.max(q.y, q.z)), 0.0)).sub(rNode)
        );
      },
      boxFrame(state, config, width, height = width, depth = width, e) {
        const pv = this.abs(state.scoped.point).sub(this.vec3(
          p5.strandsNode(width).mult(0.5),
          p5.strandsNode(height).mult(0.5),
          p5.strandsNode(depth).mult(0.5)
        ));
        const ev = p5.strandsNode(e);
        const q = this.abs(pv.add(ev)).sub(ev);
        const d1 = this.length(this.max(this.vec3(pv.x, q.y, q.z), 0.0)).add(this.min(this.max(pv.x, this.max(q.y, q.z)), 0.0));
        const d2 = this.length(this.max(this.vec3(q.x, pv.y, q.z), 0.0)).add(this.min(this.max(q.x, this.max(pv.y, q.z)), 0.0));
        const d3 = this.length(this.max(this.vec3(q.x, q.y, pv.z), 0.0)).add(this.min(this.max(q.x, this.max(q.y, pv.z)), 0.0));
        return addShape(this, state, config, this.min(this.min(d1, d2), d3));
      },
      cylinder(state, config, radius, height) {
        const p = state.scoped.point;
        const xzLen = this.length(this.vec2(p.x, p.z));
        const d2 = this.vec2(
          xzLen.sub(p5.strandsNode(radius)),
          this.abs(p.y).sub(p5.strandsNode(height).mult(0.5))
        );
        return addShape(
          this, state, config,
          this.min(this.max(d2.x, d2.y), 0.0).add(this.length(this.max(d2, 0.0)))
        );
      },
      capsule(state, config, h, r) {
        const p = state.scoped.point;
        const py = p.y.sub(this.clamp(p.y, 0.0, h));
        return addShape(this, state, config, this.length(this.vec3(p.x, py, p.z)).sub(p5.strandsNode(r)));
      },
      torus(state, config, radius, tubeRadius) {
        const p = state.scoped.point;
        const xzLen = this.length(this.vec2(p.x, p.z));
        return addShape(
          this, state, config,
          this.length(this.vec2(xzLen.sub(radius), p.y)).sub(tubeRadius)
        );
      },
      plane(state, config, nx, ny, nz, h) {
        const p = state.scoped.point;
        return addShape(
          this, state, config,
          p5.strandsNode(nx).mult(p.x).add(p5.strandsNode(ny).mult(p.y)).add(p5.strandsNode(nz).mult(p.z)).add(p5.strandsNode(h))
        );
      },
      ellipsoid(state, config, rx, ry, rz) {
        const p = state.scoped.point;
        const r = this.vec3(rx, ry, rz);
        const k0 = this.length(p.div(r));
        const k1 = this.length(p.div(r.mult(r)));
        return addShape(this, state, config, k0.mult(k0.sub(p5.strandsNode(1.0))).div(k1));
      },
      octahedron(state, config, s) {
        const p = this.abs(state.scoped.point);
        return addShape(
          this, state, config,
          p.x.add(p.y).add(p.z).sub(p5.strandsNode(s)).mult(p5.strandsNode(0.57735027))
        );
      },
    },
    read: {
      _scopedState: state => state.scoped,

      apply(state, config) {
        const { hook } = config;
        hook.dist = state.global.dist;
        for (const field of MATERIAL_FIELDS) hook[field] = state.global[field];
      },
    },
  });

  // Helpers need a reference to themselves so pop can read back restored state
  const createSDFHelper = fn.createSDF;
  fn.createSDF = function(hook, makeColor = this.color) {
    const config = {};
    const helper = createSDFHelper.call(this, hook, makeColor, config);
    config.helper = helper;
    return helper;
  };


  fn.buildSDF = function(callback) {
    const sketch = this;
    const makeColor = sketch.color;
    const shader = this.baseSDFShader().modify(callback, {}, {
      hook: 'sdfScene',
      globalInstance() {
        return this.createSDF(this.sdfScene, makeColor);
      },
    });

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
