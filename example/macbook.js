let macbook

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL)

  macbook = buildSDF(function() {
    sdfScene.begin()
    const sdf = distanceFunction(sdfScene)

    const BW = 260, BD = 175, BH = 16
    const LW = 258, LD = 172, LH = 6
    const CR = 4

    // Hinge sits at the back top edge of the base
    const HY = -BH / 2
    const HZ = -BD / 2

    const t = millis() * 0.0008
    const lidAngle = (sin(t) * 0.5 + 0.5) * (PI * 100 / 180) + PI * 15 / 180

    // BASE 
    sdf.push()
    sdf.fill(185, 185, 190)
    sdf.roundBox(BW, BH, BD, CR)
    sdf.pop()

    // HINGES 
    // Two barrel cylinders at (+/- 80, HY, HZ), lying along X
    sdf.push()
    sdf.fill(155, 155, 160)
    sdf.translate(80, HY, HZ)
    sdf.rotateZ(Math.PI / 2)
    sdf.cylinder(7, 38)
    sdf.pop()

    sdf.push()
    sdf.fill(155, 155, 160)
    sdf.translate(-80, HY, HZ)
    sdf.rotateZ(Math.PI / 2)
    sdf.cylinder(7, 38)
    sdf.pop()

    // LID 
    sdf.push()
    sdf.fill(185, 185, 190)
    sdf.translate(0, HY, HZ)
    sdf.rotateX(lidAngle)
    sdf.translate(0, -LH / 2, BD / 2)
    sdf.roundBox(LW, LH, LD, CR)
    sdf.pop()

    // Screen face (dark display on inner face of lid)
    sdf.push()
    sdf.fill(15, 15, 20)
    sdf.translate(0, HY, HZ)
    sdf.rotateX(lidAngle)
    sdf.translate(0, -0.5, BD / 2)
    sdf.roundBox(LW - 28, 2, LD - 24, 3)
    sdf.pop()

    // Camera notch
    sdf.push()
    sdf.fill(10, 10, 12)
    sdf.translate(0, HY, HZ)
    sdf.rotateX(lidAngle)
    sdf.translate(0, -0.5, BD / 2 + LD / 2 - 10)
    sdf.roundBox(28, 2, 8, 2)
    sdf.pop()

    // KEYBOARD 
    // Dark deck panel (the recessed keyboard area)
    sdf.push()
    sdf.fill(38, 38, 42)
    sdf.translate(0, HY - 0.5, -32)
    sdf.roundBox(214, 2, 82, 4)
    sdf.pop()

    // Keys: 4 rows of 10, back-to-front (row 0 = back/function row)
    const cols = 10
    const keyW = 14, keyH = 4, keyD = 14, keyR = 2
    const pitchX = 18, pitchZ = 14
    const kX0 = -(cols - 1) * pitchX / 2   // x of leftmost key
    const kZ0 = -61                          // back row z
    const kY = HY - 2                        // key center y (protrudes above base)

    sdf.times(4).each(function(row) {
      sdf.times(10).each(function(col) {
        sdf.push()
        sdf.fill(68, 68, 74)
        sdf.translate(kX0 + col * pitchX, kY, kZ0 + row * pitchZ)
        sdf.roundBox(keyW, keyH, keyD, keyR)
        sdf.pop()
      })
    })

    // Space bar (front of keyboard)
    sdf.push()
    sdf.fill(68, 68, 74)
    sdf.translate(0, kY, kZ0 + 4 * pitchZ)
    sdf.roundBox(100, keyH, keyD, keyR)
    sdf.pop()

    // TRACKPAD 
    sdf.push()
    sdf.fill(172, 172, 180)
    sdf.translate(0, HY - 0.5, 42)
    sdf.roundBox(110, 2, 62, 6)
    sdf.pop()

    sdf.apply()
    sdfScene.end()
  })
}

function draw() {
  background(30)
  orbitControl()
  noStroke()
  lights()
  specularMaterial(200)
  shininess(100)

  translate(0, 20, 0)
  rotateX(-0.3)

  macbook.draw(270)
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight)
}
