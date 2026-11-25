let shape

function setup() {
  createCanvas(200, 200, WEBGL)
  shape = buildSDF(() => {
    smoothUnion(40)
    fill(255, 80, 80)
    translate(-45, 0, 0)
    sphere(50)
    fill(80, 80, 255)
    translate(90, 0, 0)
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
