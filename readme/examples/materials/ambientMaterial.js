let shape

function setup() {
  createCanvas(200, 200, WEBGL)
  shape = buildSDF(() => {
    ambientMaterial(255, 80, 80)
    sphere(80)
  })
}

function draw() {
  background(30)
  orbitControl()
  ambientLight(70)
  directionalLight(200, 200, 200, 0.3, 0.6, -1)
  specularMaterial(150)
  shininess(100)
  shape.draw()
}
