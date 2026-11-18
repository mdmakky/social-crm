/* Social CRM website chat loader. No dependencies. Usage:
 *   <script src="https://YOUR-APP/widget.js" data-widget-key="KEY" async></script>
 * It adds a launcher button and an iframe that shows YOUR-APP/widget/KEY. Styles are set through the DOM (no inline <style>), so strict style-src policies on the host page do not block it. */
(function () {
  "use strict";
  var s = document.currentScript || document.querySelector("script[data-widget-key]");
  if (!s || window.__crmChat) return;
  var key = s.getAttribute("data-widget-key");
  if (!key || !/^[A-Za-z0-9_-]{22,64}$/.test(key)) return;
  window.__crmChat = true;
  var base = new URL(s.src, location.href).origin;
  var color = /^#[0-9a-fA-F]{6}$/.test(s.getAttribute("data-color") || "") ? s.getAttribute("data-color") : "#2563eb";
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var grant = s.getAttribute("data-preview-grant"); // owner preview only (settings, web chat): a signed 10 minute grant, useless on any other site
  var open = false, frame = null;

  function css(el, o) { for (var k in o) el.style[k] = o[k]; }
  var btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", "Chat with us");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-haspopup", "dialog");
  btn.textContent = "💬"; // speech balloon
  css(btn, { position: "fixed", right: "20px", bottom: "20px", width: "56px", height: "56px", borderRadius: "28px", border: "0", background: color, color: "#fff", fontSize: "26px", lineHeight: "1", cursor: "pointer", boxShadow: "0 4px 16px rgba(0,0,0,.25)", zIndex: "2147483000", padding: "0" });
  btn.style.fontSize = "26px";
  if (!reduce) btn.style.transition = "transform .15s";

  var box = document.createElement("div");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Chat");
  box.hidden = true;
  css(box, { position: "fixed", zIndex: "2147483001", overflow: "hidden", background: "#fff", boxShadow: "0 8px 32px rgba(0,0,0,.28)" });
  if (!reduce) box.style.transition = "opacity .15s";

  function layout() {
    var small = window.innerWidth < 480;
    if (small) css(box, { top: "0", left: "0", right: "0", bottom: "0", width: "auto", height: "auto", borderRadius: "0" });
    else css(box, { top: "auto", left: "auto", right: "20px", bottom: "88px", width: "380px", height: "min(600px, calc(100vh - 108px))", borderRadius: "16px" });
    btn.style.display = small && open ? "none" : "block"; // the sheet has its own close button
  }
  function toggle(want) {
    open = want === undefined ? !open : want;
    if (open && !frame) {
      frame = document.createElement("iframe");
      frame.title = "Chat";
      frame.src = base + "/widget/" + key + "?host=" + encodeURIComponent(location.origin) + (grant ? "&preview=" + encodeURIComponent(grant) : "");
      frame.setAttribute("allow", "");
      css(frame, { border: "0", width: "100%", height: "100%", display: "block" });
      box.appendChild(frame);
    }
    box.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-label", open ? "Close chat" : "Chat with us");
    layout();
    if (open) { try { frame.contentWindow.focus(); } catch { frame.focus(); } } else btn.focus();
  }
  btn.addEventListener("click", function () { toggle(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && open) toggle(false); });
  window.addEventListener("resize", layout);
  window.addEventListener("message", function (e) {
    if (e.origin === base && frame && e.source === frame.contentWindow && e.data && e.data.type === "crm-chat:close") toggle(false);
  });
  function mount() { document.body.appendChild(box); document.body.appendChild(btn); layout(); }
  function go() { if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount); }
  // Ask the chat server first: a site that is not allowed for this key gets no launcher at all (the browser hides the 403 behind a CORS error, so any failure reads the same).
  fetch(base + "/public/widget/" + key + "/config", grant ? { headers: { "x-widget-preview": grant } } : {}).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; }).then(function (c) {
    if (!c) return console.warn("Chat widget not shown: this site's origin is not allowed for this widget key");
    if (!c.enabled) console.warn("Chat widget is switched off in Social CRM: visitors see the offline message");
    go();
  });
})();
