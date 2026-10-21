let macbook

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL)

  macbook = buildSDF(function() {
    debugger

    const BW = 260, BD = 175, BH = 16
    const LW = 258, LD = 172, LH = 6
    const CR = 4

    // Hinge sits at the back top edge of the base
    const HY = -BH / 2
    const HZ = -BD / 2

    const t = millis() * 0.0008
    const lidAngle = (sin(t) * 0.5 + 0.5) * (PI * 100 / 180) + PI * 15 / 180

    // BASE 
    push()
    fill(185, 185, 190)
    roundBox(BW, BH, BD, CR)
    pop()

    // HINGES 
    // Two barrel cylinders at (+/- 80, HY, HZ), lying along X
    push()
    fill(155, 155, 160)
    translate(80, HY, HZ)
    rotateZ(Math.PI / 2)
    cylinder(7, 38)
    pop()

    push()
    fill(155, 155, 160)
    translate(-80, HY, HZ)
    rotateZ(Math.PI / 2)
    cylinder(7, 38)
    pop()

    // LID 
    push()
    fill(185, 185, 190)
    translate(0, HY, HZ)
    rotateX(lidAngle)
    translate(0, -LH / 2, BD / 2)
    roundBox(LW, LH, LD, CR)
    pop()

    // Screen face (dark display on inner face of lid)
    push()
    fill(15, 15, 20)
    translate(0, HY, HZ)
    rotateX(lidAngle)
    translate(0, -0.5, BD / 2)
    roundBox(LW - 28, 2, LD - 24, 3)
    pop()

    // Camera notch
    push()
    fill(10, 10, 12)
    translate(0, HY, HZ)
    rotateX(lidAngle)
    translate(0, -0.5, BD / 2 + LD / 2 - 10)
    roundBox(28, 2, 8, 2)
    pop()

    // KEYBOARD 
    // Dark deck panel (the recessed keyboard area)
    push()
    fill(38, 38, 42)
    translate(0, HY - 0.5, -32)
    roundBox(214, 2, 82, 4)
    pop()

    // Keys: 4 rows of 10, back-to-front (row 0 = back/function row)
    const cols = 10
    const keyW = 14, keyH = 4, keyD = 14, keyR = 2
    const pitchX = 18, pitchZ = 14
    const kX0 = -(cols - 1) * pitchX / 2   // x of leftmost key
    const kZ0 = -61                          // back row z
    const kY = HY - 2                        // key center y (protrudes above base)

    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < cols; col++) {
        push()
        fill(68, 68, 74)
        translate(kX0 + col * pitchX, kY, kZ0 + row * pitchZ)
        roundBox(keyW, keyH, keyD, keyR)
        pop()
      }
    }

    // Space bar (front of keyboard)
    push()
    fill(68, 68, 74)
    translate(0, kY, kZ0 + 4 * pitchZ)
    roundBox(100, keyH, keyD, keyR)
    pop()

    // TRACKPAD 
    push()
    fill(172, 172, 180)
    translate(0, HY - 0.5, 42)
    roundBox(110, 2, 62, 6)
    pop()

    apply()
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
