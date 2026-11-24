// auth-guard.js
(function verificarSesion() {
  const token = sessionStorage.getItem("wm_session_token");

  // 1. Si no existe la variable de sesión en el navegador, redirigir de inmediato
  if (!token) {
    window.location.replace("login.html");
    return;
  }

  // 2. Validar contra IS que la sesión (cookie ssnid) no haya expirado por inactividad
  fetch("/rest/auth/login", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest"
    },
    credentials: "include" // Envía automáticamente la cookie ssnid al servidor
  })
  .then(res => {
    if (!res.ok) {
      sessionStorage.clear();
      window.location.replace("login.html");
    }
  })
  .catch(() => {
    sessionStorage.clear();
    window.location.replace("login.html");
  });
})();

// Función para cerrar sesión
function cerrarSesion() {
  sessionStorage.clear();
  // Opcional: invocar wm.server:disconnect en IS para destruir la sesión en servidor
  window.location.replace("login.html");
}