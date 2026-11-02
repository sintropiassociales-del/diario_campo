/**
 * ============================================================
 *  KILL-SWITCH v2 — Cortafuegos de aplicación + registro anónimo
 *  Sintropía Social
 * ------------------------------------------------------------
 *  Pega este archivo en cada sitio y enlázalo en el <head>:
 *      <script src="kill-switch.js" defer></script>
 *
 *  Hace tres cosas:
 *   1) Pregunta al Panel si el sitio debe estar ON u OFF (y si
 *      está OFF muestra pantalla de mantenimiento).
 *   2) Esa misma consulta cuenta la visita (anónima: solo suma,
 *      nunca correo ni IP).
 *   3) Al cerrar/ocultar la página, envía cuánto tiempo estuvo
 *      abierta (anónimo), para la métrica de permanencia.
 * ============================================================
 */
(function () {
  // ====== CONFIGURA ESTAS 2 LÍNEAS POR SITIO ======
  var ENDPOINT = "https://script.google.com/macros/s/AKfycbyt8u9X0th8ExO-O-1STwgKzhf7KdvStRlsG4yKPJn-65W09vc9RD5WuwLL0fAHZ33y/exec"; // termina en /exec
  var SITE_ID  = "Trazo"; // mismo id que en el dashboard / columna "Nombre"
  // =================================================

  var FAIL_OPEN = true; // true = si el Panel no responde, el sitio sigue ON
  var inicio = Date.now();
  var enviado = false;

  // 1 + 2) Consulta estado (y cuenta la visita del lado del servidor)
  try {
    fetch(ENDPOINT + "?site=" + encodeURIComponent(SITE_ID), { method: "GET" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && String(d.estado).toUpperCase() === "OFF") mostrarMantenimiento(d.mensaje);
      })
      .catch(function () { if (!FAIL_OPEN) mostrarMantenimiento(); });
  } catch (e) { if (!FAIL_OPEN) mostrarMantenimiento(); }

  // 3) Permanencia: al ocultar o cerrar la pestaña, mandamos la duración una sola vez
  function enviarTiempo() {
    if (enviado) return; enviado = true;
    var ms = Date.now() - inicio;
    try {
      fetch(ENDPOINT + "?bye=" + encodeURIComponent(SITE_ID) + "&ms=" + ms, { method: "GET", keepalive: true });
    } catch (e) {}
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") enviarTiempo();
  });
  window.addEventListener("pagehide", enviarTiempo);

  // ---- Pantalla de mantenimiento ----
  function mostrarMantenimiento(mensaje) {
    var texto = mensaje || "Estamos en mantenimiento. Volvemos muy pronto.";
    var overlay = document.createElement("div");
    overlay.setAttribute("role", "alert");
    overlay.style.cssText = [
      "position:fixed", "inset:0", "z-index:2147483647",
      "display:flex", "flex-direction:column",
      "align-items:center", "justify-content:center",
      "background:#0f2235", "color:#ffffff",
      "font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
      "text-align:center", "padding:24px", "box-sizing:border-box"
    ].join(";");
    overlay.innerHTML =
      '<div style="max-width:480px">' +
        '<div style="font-size:48px;margin-bottom:16px">🔧</div>' +
        '<h1 style="font-size:24px;margin:0 0 12px;font-weight:700">En mantenimiento</h1>' +
        '<p style="font-size:16px;line-height:1.5;opacity:.85;margin:0">' + escapar(texto) + '</p>' +
      '</div>';
    document.documentElement.style.overflow = "hidden";
    if (document.body) document.body.appendChild(overlay);
    else document.addEventListener("DOMContentLoaded", function () { document.body.appendChild(overlay); });
  }
  function escapar(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
})();
