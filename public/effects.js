// Conecta los efectos visuales. Aislado de app.js: si WebGL/algo falla,
// la aplicación sigue funcionando igual.
import { initLightRays } from "./lightrays.js";
import { attachSpecular } from "./specular.js";
import { splitText } from "./splittext.js";

// Fondo de rayos de luz
try {
  const bg = document.getElementById("bg");
  if (bg) {
    initLightRays(bg, {
      raysColor: "#3fd2ff",
      raysOrigin: "top-center",
      raysSpeed: 1.15,
      lightSpread: 0.85,
      rayLength: 1.7,
      followMouse: true,
      mouseInfluence: 0.1,
      noiseAmount: 0.08,
      distortion: 0.03,
    });
  }
} catch (e) {
  console.warn("LightRays no disponible:", e);
}

// Botones con brillo specular
try {
  const b1 = document.getElementById("btn-incidencia");
  if (b1) attachSpecular(b1, {
    lineColor: "#8fe4ff", baseColor: "#3a4150", radius: 12,
    intensity: 1.15, autoAnimate: true, speed: 0.5, proximity: 320,
  });
  const b2 = document.getElementById("btn-nuevodia");
  if (b2) attachSpecular(b2, {
    lineColor: "#8dffcb", baseColor: "#3a4150", radius: 12,
    intensity: 1.05, proximity: 280,
  });
} catch (e) {
  console.warn("SpecularButton no disponible:", e);
}

// Título animado por caracteres
try {
  const t = document.getElementById("titulo");
  if (t) splitText(t, { delay: 45, duration: 0.7 });
} catch (e) {
  console.warn("SplitText no disponible:", e);
}
