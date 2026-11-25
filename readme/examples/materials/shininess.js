let shape

function setup() {
  createCanvas(200, 200, WEBGL)
  shape = buildSDF(() => {
    translate(-60, 0, 0)
    shininess(5)
    sphere(50)
    translate(120, 0, 0)
    shininess(40)
    sphere(50)
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
