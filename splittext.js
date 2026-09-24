// SplitText en vanilla: parte el texto en caracteres y los anima escalonados
// (mismo efecto que el componente de React Bits, sin gsap).
export function splitText(el, opts = {}) {
  const o = {
    delay: 45,          // ms entre caracteres
    duration: 0.7,      // s por caracter
    ease: "cubic-bezier(0.16, 1, 0.3, 1)", // ~ power3.out
    fromY: 40,
    threshold: 0.1,
    ...opts,
  };

  const text = el.textContent;
  el.textContent = "";
  el.style.display = "inline-block";

  const spans = [];
  for (const ch of text) {
    const span = document.createElement("span");
    span.className = "split-char";
    span.textContent = ch === " " ? " " : ch;
    span.style.display = "inline-block";
    span.style.willChange = "transform, opacity";
    span.style.opacity = "0";
    span.style.transform = `translateY(${o.fromY}px)`;
    span.style.transition = `opacity ${o.duration}s ${o.ease}, transform ${o.duration}s ${o.ease}`;
    el.appendChild(span);
    spans.push(span);
  }

  let played = false;
  const play = () => {
    if (played) return;
    played = true;
    spans.forEach((span, i) => {
      setTimeout(() => {
        span.style.opacity = "1";
        span.style.transform = "translateY(0)";
      }, i * o.delay);
    });
  };

  const io = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting) {
        play();
        io.disconnect();
      }
    },
    { threshold: o.threshold }
  );
  io.observe(el);
}
