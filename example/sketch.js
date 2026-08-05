let mySDF

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL)

  mySDF = buildSDF(function() {
    sdfScene.begin()
    let sdf = distanceFunction(sdfScene)

    // sdf.smoothUnion(30)
    sdf.push()
    sdf.translate(100 + 50 * sin(millis() * 0.001), 0, 0)
    sdf.sphere(40)
    sdf.pop()
    sdf.sphere(60)

    sdfScene.dist = sdf.get()
    sdfScene.end()
  })
  console.log(mySDF.shader.fragSrc())
}

function draw() {
  background(50)
  orbitControl()
  noStroke()
  lights()
  fill(200, 80, 80)
  mySDF.draw(200)
  // sphere(40)

  push()
  fill('green')
  const angle = millis() * 0.001
  const r = 300
  translate(r*cos(angle), 0, r*sin(angle))
  box(50)
  pop()
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight)
}
