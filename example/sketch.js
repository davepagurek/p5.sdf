let mySDF

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL)

  mySDF = buildSDF(function() {
    sdfScene.begin()
    let sdf = distanceFunction(sdfScene)

    sdf.smoothUnion(30)
    sdf.push()
    sdf.translate(50, 0, 0)
    sdf.sphere(40)
    sdf.pop()
    sdf.sphere(60)

    sdfScene.dist = sdf.get()
    sdfScene.end()
  })
}

function draw() {
  background(50)
  orbitControl()
  noStroke()
  lights()
  fill(200, 80, 80)
  mySDF.draw(200)
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight)
}
