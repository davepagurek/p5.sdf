const CELL = 220
const COLS = 4
const sdfs = []

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL)

  sdfs.push(buildSDF(function() {
    sphere(70)
  }))

  sdfs.push(buildSDF(function() {
    box(120)
  }))

  sdfs.push(buildSDF(function() {
    roundBox(120, 120, 120, 15)
  }))

  sdfs.push(buildSDF(function() {
    boxFrame(120, 120, 120, 8)
  }))

  sdfs.push(buildSDF(function() {
    cylinder(60, 100)
  }))

  sdfs.push(buildSDF(function() {
    capsule(80, 40)
  }))

  sdfs.push(buildSDF(function() {
    torus(60, 20)
  }))

  sdfs.push(buildSDF(function() {
    ellipsoid(80, 50, 40)
  }))

  sdfs.push(buildSDF(function() {
    shininess(3)
    octahedron(80)
  }))

  sdfs.push(buildSDF(function() {
    sphere(70)
    intersect()
    infinitePlane(0, 1, 0, 10)
  }))

  sdfs.push(buildSDF(function() {
    sphere(75)
    subtract()
    cylinder(35, 200)
  }))

  sdfs.push(buildSDF(function() {
    sphere(80)
    intersect()
    box(100)
  }))

  sdfs.push(buildSDF(function() {
    smoothUnion(30)
    push()
    translate(35, 0, 0)
    sphere(50)
    pop()
    translate(-35, 0, 0)
    sphere(50)
  }))

  sdfs.push(buildSDF(function() {
    sphere(75)
    smoothSubtract(25)
    cylinder(45, 200)
  }))

  sdfs.push(buildSDF(function() {
    sphere(80)
    smoothIntersect(30)
    box(100)
  }))

  sdfs.push(buildSDF(function() {
    rounded(12, () => {
      box(90)
    })
  }))

  sdfs.push(buildSDF(function() {
    onion(8, () => {
      sphere(65)
    })
  }))

  sdfs.push(buildSDF(function() {
    mirror('x')
    translate(40, 0, 0)
    sphere(40)
  }))

  sdfs.push(buildSDF(function() {
    elongate(30, 0, 0)
    sphere(50)
  }))

  sdfs.push(buildSDF(function() {
    twist(0.04)
    box(60, 140, 60)
  }))

  sdfs.push(buildSDF(function() {
    bend(0.015)
    rotateZ(Math.PI / 2)
    cylinder(25, 180)
  }))

  sdfs.push(buildSDF(function() {
    fill(255, 80, 80)
    smoothUnion(30)
    push()
    fill(80, 80, 255)
    translate(35, 0, 0)
    sphere(50)
    pop()
    translate(-35, 0, 0)
    sphere(50)
  }))

  sdfs.push(buildSDF(function() {
    onion(8, () => {
      sphere(65)
    })
    intersect()
    infinitePlane(0, 1, 0, 0)
  }))

  sdfs.push(buildSDF(function() {
    push()
    scale(0.6)
    box(120)
    pop()
    smoothUnion(20)
    sphere(40)
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
