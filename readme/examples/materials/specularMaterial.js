let shape

function setup() {
  createCanvas(200, 200, WEBGL)
  shape = buildSDF(() => {
    fill(120)
    specularMaterial(0, 255, 0)
    shininess(20)
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
