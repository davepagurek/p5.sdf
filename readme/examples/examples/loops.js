let shape

function setup() {
  createCanvas(200, 200, WEBGL)
  shape = buildSDF(() => {
    smoothUnion(20)
    for (let i = 0; i < 8; i++) {
      push()
      rotateY(i * Math.PI / 4)
      translate(70, 0, 0)
      sphere(22)
      pop()
    }
  })
}

function draw() {
  background(30)
  orbitControl()
  ambientLight(70)
  directionalLight(200, 200, 200, 0.3, 0.6, -1)
  specularMaterial(150)
  shininess(100)
  shape.draw(200)
}
