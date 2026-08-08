let mySDF

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL)

  mySDF = buildSDF(function() {
    sdfScene.begin()
    let sdf = distanceFunction(sdfScene)

    sdf.smoothUnion(30)
    sdf.fill('red')
    sdf.push()
    sdf.shininess(5)
    sdf.translate(100 + 50 * sin(millis() * 0.001), 0, 0)
    sdf.sphere(40)
    sdf.pop()
    sdf.fill('blue')
    sdf.box(60)

    sdf.apply()
    sdfScene.end()
  })
  console.log(mySDF.shader.fragSrc())
}

function draw() {
  background(0)
  orbitControl()
  noStroke()
  lights()
  specularMaterial(200)
  shininess(300)
  push()
  translate(0, 100*sin(millis()*0.001))
  mySDF.draw(200)
  pop()

  push()
  fill('green')
  const angle = millis() * 0.001
  const r = 150
  translate(r*cos(angle), 0, r*sin(angle))
  box(50)
  pop()
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight)
}
