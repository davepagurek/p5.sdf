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

  // registerStrandsState splits a helper's state into scoped fields, which
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

  fn.distanceFunction = p5.registerStrandsState('distanceFunction', {
    init(hook) {
      const config = {
        hook,
        computeMaterial: hook.computeMaterial,
        constants: new Map(),
      };
      const defaults = {};
      for (const field of MATERIAL_FIELDS) {
        defaults[field] = hook[field];
      }
      return {
        config,
        state: {
          scoped: {
            point: hook.point,
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
      ////////////////////////
      // TRANSFORMS
      ////////////////////////
      translate(state, config, x, y = 0, z = 0) {
        return movePoint(this, state, identity =>
          this.translate(identity, neg(x), neg(y), neg(z))
        );
      },
      scale(state, config, s) {
        return withScoped(state, {
          point: state.scoped.point.div(node(s)),
          distScale: state.scoped.distScale.mult(node(s)),
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
      // PRIMITIVES
      ////////////////////////
      sphere: shape((sketch, p, r) => sketch.length(p).sub(r)),
      box: shape((sketch, p, width, height = width, depth = width) => {
        const b = sketch.vec3(
          node(width).mult(0.5),
          node(height).mult(0.5),
          node(depth).mult(0.5)
        );
        const q = sketch.abs(p).sub(b);
        return sketch.length(sketch.max(q, 0.0)).add(sketch.min(sketch.max(q.x, sketch.max(q.y, q.z)), 0.0));
      }),
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
      cylinder: shape((sketch, p, radius, height) => {
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
      torus: shape((sketch, p, radius, tubeRadius) => {
        const xzLen = sketch.length(sketch.vec2(p.x, p.z));
        return sketch.length(sketch.vec2(xzLen.sub(radius), p.y)).sub(tubeRadius);
      }),
      plane: shape((sketch, p, nx, ny, nz, h) =>
        node(nx).mult(p.x).add(node(ny).mult(p.y)).add(node(nz).mult(p.z)).add(node(h))
      ),
      ellipsoid: shape((sketch, p, rx, ry, rz) => {
        const r = sketch.vec3(rx, ry, rz);
        const k0 = sketch.length(p.div(r));
        const k1 = sketch.length(p.div(r.mult(r)));
        return k0.mult(k0.sub(node(1.0))).div(k1);
      }),
      octahedron: shape((sketch, p, s) => {
        const q = sketch.abs(p);
        return q.x.add(q.y).add(q.z).sub(node(s)).mult(node(0.57735027));
      }),
    },

    read: {
      apply(state, config) {
        const { hook } = config;
        hook.dist = state.global.dist;
        for (const field of MATERIAL_FIELDS) {
          hook[field] = state.global[field];
        }
      },
    },
  });

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
