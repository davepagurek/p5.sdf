let shape
let environment

async function setup() {
  createCanvas(200, 200, WEBGL)
  environment = await loadImage('outdoor_spheremap.jpg')
  shape = buildSDF(() => {
    translate(-60, 0, 0)
    metalness(0)
    sphere(50)
    translate(120, 0, 0)
    metalness(1)
    sphere(50)
  })
}

function draw() {
  background(30)
  orbitControl()
  imageLight(environment)
  specularMaterial(150)
  shininess(100)
  shape.draw()
}
