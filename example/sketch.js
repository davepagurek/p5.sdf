const CELL = 220
const COLS = 4
const sdfs = []

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL)

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.sphere(70)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.box(120)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.roundBox(120, 120, 120, 15)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.boxFrame(120, 120, 120, 8)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.cylinder(60, 100)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.capsule(80, 40)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.torus(60, 20)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.ellipsoid(80, 50, 40)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.octahedron(80)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.sphere(70)
    sdf.intersect()
    sdf.plane(0, 1, 0, 10)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.sphere(75)
    sdf.subtract()
    sdf.cylinder(35, 200)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.sphere(80)
    sdf.intersect()
    sdf.box(100)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.smoothUnion(30)
    sdf.push()
    sdf.translate(35, 0, 0)
    sdf.sphere(50)
    sdf.pop()
    sdf.translate(-35, 0, 0)
    sdf.sphere(50)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.sphere(75)
    sdf.smoothSubtract(25)
    sdf.cylinder(45, 200)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.sphere(80)
    sdf.smoothIntersect(30)
    sdf.box(100)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.round(12)
    sdf.box(90)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.onion(8)
    sdf.sphere(65)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.mirror('x')
    sdf.translate(40, 0, 0)
    sdf.sphere(40)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.elongate(30, 0, 0)
    sdf.sphere(50)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.twist(0.04)
    sdf.box(60, 140, 60)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.bend(0.015)
    sdf.rotateZ(Math.PI / 2)
    sdf.cylinder(25, 180)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.fill(255, 80, 80)
    sdf.smoothUnion(30)
    sdf.push()
    sdf.fill(80, 80, 255)
    sdf.translate(35, 0, 0)
    sdf.sphere(50)
    sdf.pop()
    sdf.translate(-35, 0, 0)
    sdf.sphere(50)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.onion(8)
    sdf.sphere(65)
    sdf.intersect()
    sdf.plane(0, 1, 0, 0)
    sdf.apply()
    sdfScene.end()
  }))

  sdfs.push(buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)
    sdf.push()
    sdf.scale(0.6)
    sdf.box(120)
    sdf.pop()
    sdf.smoothUnion(20)
    sdf.sphere(40)
    sdf.apply()
    sdfScene.end()
  }))
}

function draw() {
  background(30)
  orbitControl()
  noStroke()
  lights()
  specularMaterial(200)
  shininess(150)

  const rows = Math.ceil(sdfs.length / COLS)
  const gridW = COLS * CELL
  const gridH = rows * CELL

  for (let i = 0; i < sdfs.length; i++) {
    const col = i % COLS
    const row = Math.floor(i / COLS)
    const x = (col + 0.5) * CELL - gridW / 2
    const y = (row + 0.5) * CELL - gridH / 2
    push()
    translate(x, y, 0)
    sdfs[i].draw(200)
    pop()
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight)
}
