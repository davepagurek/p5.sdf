let shape

function setup() {
  createCanvas(200, 200, WEBGL)
  shape = buildSDF(() => {
    onion(2, () => {
      onion(6, () => {
        onion(14, () => {
          sphere(90)
        })
      })
    })
    intersect()
    plane(0, 0, 1, 0)
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
