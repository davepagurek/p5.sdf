let shape

function setup() {
  createCanvas(200, 200, WEBGL)
  shape = buildSDF(() => {
    sphere(55)
    translate(50, 0, 0)
    sphere(55)
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
