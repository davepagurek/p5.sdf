let shape

function setup() {
  createCanvas(200, 200, WEBGL)
  shape = buildSDF(() => {
    fill(255, 120, 60)
    box(120, 60, 60)
  })
}

function draw() {
  background(30)
  orbitControl()
  ambientLight(70)
  directionalLight(200, 200, 200, 0.3, 0.6, -1)
  specularMaterial(150)
  shininess(100)
  // Covers the shape with a box instead of a sphere
  shape.draw(() => box(160, 100, 100))
}
