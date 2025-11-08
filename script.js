document.addEventListener("DOMContentLoaded", () => {
  gsap.registerPlugin(ScrollTrigger);

  // ---- smooth scroll + GSAP sync
  const lenis = new Lenis();
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);

  // ---- config
  const CONFIG = {
    gravity: { x: 0, y: 1 },
    restitution: 0.5,
    friction: 0.15,
    frictionAir: 0.02,
    density: 0.002,
    wallThickness: 200,
    mouseStiffness: 0.6,
    maxLinVel: 20,
    spawnOffsetY: 500,
  };

  // ---- state
  let engine = null,
    runner = null,
    mouseConstraint = null,
    topWall = null,
    containerRect = null;

  // Body → meta (DOM element + size). O(1) доступ під час drag/рендеру.
  const meta = new WeakMap();

  // utils
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const on = (el, evt, fn, opt) => el.addEventListener(evt, fn, opt || { passive: true });

  function destroyPhysics() {
    if (!engine) return;
    Matter.Engine.clear(engine);
    if (runner) Matter.Runner.stop(runner);
    engine = runner = mouseConstraint = topWall = null;
    meta && meta.clear?.();
  }

  function initPhysics(container) {
    destroyPhysics();

    engine = Matter.Engine.create();
    engine.gravity = CONFIG.gravity;
    engine.constraintIterations = 10;
    engine.positionIterations = 20;
    engine.timing.timeScale = 1;

    containerRect = container.getBoundingClientRect();
    const W = containerRect.width;
    const H = containerRect.height;
    const T = CONFIG.wallThickness;

    // --- walls (L/R/Bottom). Верхню ставимо із затримкою як у тебе.
    const walls = [
      Matter.Bodies.rectangle(W / 2, H + T / 2, W + T * 2, T, { isStatic: true }),     // bottom
      Matter.Bodies.rectangle(-T / 2, H / 2, T, H + T * 2, { isStatic: true }),         // left
      Matter.Bodies.rectangle(W + T / 2, H / 2, T, H + T * 2, { isStatic: true }),      // right
    ];
    Matter.World.add(engine.world, walls);

    // --- bodies
    container.querySelectorAll(".object").forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const startX = Math.random() * (W - r.width) + r.width / 2;
      const startY = -150 - Math.random() * 200;
      const angle = (Math.random() - 0.5) * Math.PI;

      const body = Matter.Bodies.rectangle(
        startX,
        startY,
        r.width,
        r.height,
        {
          restitution: CONFIG.restitution,
          friction: CONFIG.friction,
          frictionAir: CONFIG.frictionAir,
          density: CONFIG.density
        }
      );
      Matter.Body.setAngle(body, angle);
      Matter.World.add(engine.world, body);

      // кеш метаданих
      meta.set(body, { el, w: r.width, h: r.height });
      // підготувати елемент до cheap transforms
      el.style.willChange = "transform";
      el.style.position = "absolute";
      el.style.left = "0";   // не змінюємо з кадру в кадр
      el.style.top = "0";
    });

    // --- delayed top wall (як у твоїй логіці)
    setTimeout(() => {
      if (!engine) return;
      topWall = Matter.Bodies.rectangle(W / 2, -T / 2, W + T * 2, T, { isStatic: true });
      Matter.World.add(engine.world, topWall);
    }, 3000);

    // --- mouse
    const mouse = Matter.Mouse.create(container);
    mouse.element.removeEventListener("mousewheel", mouse.mousewheel);
    mouse.element.removeEventListener("DOMMouseScroll", mouse.mousewheel);

    mouseConstraint = Matter.MouseConstraint.create(engine, {
      mouse,
      constraint: { stiffness: CONFIG.mouseStiffness, render: { visible: false } }
    });
    mouseConstraint.mouse.element.oncontextmenu = () => false;
    Matter.World.add(engine.world, mouseConstraint);

    // drag inertia lock
    let dragging = null, originalInertia = null;
    Matter.Events.on(mouseConstraint, "startdrag", (e) => {
      dragging = e.body;
      if (!dragging) return;
      originalInertia = dragging.inertia;
      Matter.Body.setInertia(dragging, Infinity);
      Matter.Body.setVelocity(dragging, { x: 0, y: 0 });
      Matter.Body.setAngularVelocity(dragging, 0);
    });
    Matter.Events.on(mouseConstraint, "enddrag", () => {
      if (!dragging) return;
      Matter.Body.setInertia(dragging, originalInertia || 1);
      dragging = originalInertia = null;
    });

    // clamp під час drag (рідко спрацьовує; дешево)
    Matter.Events.on(engine, "beforeUpdate", () => {
      if (!dragging) return;
      const m = meta.get(dragging);
      if (!m) return;

      const minX = m.w / 2, maxX = W - m.w / 2;
      const minY = m.h / 2, maxY = H - m.h / 2;

      Matter.Body.setPosition(dragging, {
        x: clamp(dragging.position.x, minX, maxX),
        y: clamp(dragging.position.y, minY, maxY)
      });
      Matter.Body.setVelocity(dragging, {
        x: clamp(dragging.velocity.x, -CONFIG.maxLinVel, CONFIG.maxLinVel),
        y: clamp(dragging.velocity.y, -CONFIG.maxLinVel, CONFIG.maxLinVel)
      });
    });

    // один цикл рендера: після апдейту фізики
    Matter.Events.on(engine, "afterUpdate", () => {
      const bodies = Matter.Composite.allBodies(engine.world);
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        const m = meta.get(b);
        if (!m) continue; // пропускаємо стіни
        const x = clamp(b.position.x - m.w / 2, 0, W - m.w);
        const y = clamp(b.position.y - m.h / 2, -m.h * 3, H - m.h);
        // без змін left/top → не провокуємо layout
        m.el.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${b.angle}rad)`;
      }
    });

    // безпечні скидання
    on(container, "mouseleave", () => {
      if (!mouseConstraint) return;
      mouseConstraint.constraint.bodyB = null;
      mouseConstraint.constraint.pointB = null;
    });
    on(document, "mouseup", () => {
      if (!mouseConstraint) return;
      mouseConstraint.constraint.bodyB = null;
      mouseConstraint.constraint.pointB = null;
    });

    // run
    runner = Matter.Runner.create();
    Matter.Runner.run(runner, engine);
  }

  // ---- запуск по скролу (одноразово на секцію з контейнером)
  document.querySelectorAll("section").forEach((section) => {
    const container = section.querySelector(".object-container");
    if (!container) return;

    ScrollTrigger.create({
      trigger: section,
      start: "top bottom",
      once: true,
      onEnter: () => { if (!engine) initPhysics(container); }
    });
  });

  // ---- ресайз (перебудувати світ — найнадійніше)
  let rezTO;
  on(window, "resize", () => {
    clearTimeout(rezTO);
    rezTO = setTimeout(() => {
      const activeContainer = document.querySelector(".object-container");
      if (activeContainer) initPhysics(activeContainer);
    }, 150);
  });
});
