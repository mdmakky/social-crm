/* Social CRM website chat loader. No dependencies. Usage:
 *   <script src="https://YOUR-APP/widget.js" data-widget-key="KEY" async></script>
 * It draws the launcher pill and the rounded, animated container; the chat itself is an iframe of YOUR-APP/widget/KEY.
 * Styles and animations go through the DOM (element.style, element.animate), never an inline <style>, so a strict style-src on the host page does not block them. */
(function () {
  "use strict";
  var s = document.currentScript || document.querySelector("script[data-widget-key]");
  if (!s || window.__crmChat) return;
  var key = s.getAttribute("data-widget-key");
  if (!key || !/^[A-Za-z0-9_-]{22,64}$/.test(key)) return;
  window.__crmChat = true;
  var base = new URL(s.src, location.href).origin;
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var grant = s.getAttribute("data-preview-grant"); // owner preview only (settings, web chat): a signed 10 minute grant, useless on any other site
  var open = false, frame = null, cfg = null, btn, box, badge, want = 560, EASE = "cubic-bezier(.16,1,.3,1)";
  var FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Bengali",sans-serif';
  var LABEL = { en: "Chat with us", bn: "চ্যাট করুন" };

  function css(el, o) { for (var k in o) el.style[k] = o[k]; }
  function anim(el, frames, ms, delay) { if (!reduce && el.animate) el.animate(frames, { duration: ms, delay: delay || 0, easing: EASE, fill: "backwards" }); }
  // Only the origin and path of this page ever leave it: a query string or fragment can carry tokens, emails or order numbers (decision D283).
  function pageUrl() { return location.origin + location.pathname; }
  function post(msg) { if (frame && frame.contentWindow) frame.contentWindow.postMessage(msg, base); }
  function mark(size, font) {
    var m = document.createElement("span");
    m.setAttribute("aria-hidden", "true");
    css(m, { width: size + "px", height: size + "px", borderRadius: "50%", background: cfg.color, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "700", fontSize: font + "px", flex: "none", position: "relative", overflow: "hidden" });
    var letter = (cfg.name || "C").trim().charAt(0).toUpperCase();
    if (cfg.avatarUrl) {
      var img = document.createElement("img");
      img.alt = ""; img.referrerPolicy = "no-referrer"; img.src = cfg.avatarUrl;
      css(img, { width: "100%", height: "100%", objectFit: "cover", display: "block", borderRadius: "50%" });
      img.onerror = function () { img.remove(); m.insertBefore(document.createTextNode(letter), m.firstChild); };
      m.appendChild(img);
    } else m.textContent = letter;
    return m;
  }
  function focusRing(el) {
    el.addEventListener("focus", function () { try { if (el.matches(":focus-visible")) css(el, { outline: "3px solid #1c1d22", outlineOffset: "3px" }); } catch { /* old browser: no ring */ } });
    el.addEventListener("blur", function () { css(el, { outline: "none" }); });
  }

  function side() { return cfg.position === "left" ? "left" : "right"; }
  function layout() {
    var small = window.innerWidth <= 480, sd = side();
    if (small) css(box, { top: "0", left: "0", right: "0", bottom: "0", width: "auto", height: "100dvh", borderRadius: "0", border: "0" });
    else {
      var h = Math.min(Math.max(want, 560), 660, window.innerHeight - 40);
      css(box, { top: "auto", left: "auto", right: "auto", bottom: "20px", width: "min(392px, calc(100vw - 40px))", height: h + "px", borderRadius: "22px", border: "1px solid #e4e5ea" });
      box.style[sd] = "20px";
    }
    box.style.transformOrigin = (sd === "left" ? "0%" : "100%") + " 100%";
    btn.style.display = open ? "none" : "flex"; // the panel has its own close button
  }
  function setBadge(n) {
    n = Math.max(0, Math.min(99, n | 0));
    badge.textContent = n > 9 ? "9+" : String(n);
    var was = badge.style.display !== "none";
    badge.style.display = n > 0 ? "flex" : "none";
    if (n > 0 && !was) anim(badge, [{ transform: "scale(0)" }, { transform: "scale(1)" }], 350);
    var l = LABEL[cfg.defaultLanguage] || LABEL.en;
    btn.setAttribute("aria-label", n > 0 ? l + ", " + n + (cfg.defaultLanguage === "bn" ? " নতুন বার্তা" : " new") : l);
  }
  function toggle(to) {
    open = to === undefined ? !open : to;
    box.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open) setBadge(0);
    layout();
    post({ type: "crm-chat:state", open: open, page: pageUrl() });
    if (open) {
      anim(box, [{ opacity: 0, transform: "scale(.94) translateY(10px)" }, { opacity: 1, transform: "none" }], 260);
      try { frame.contentWindow.focus(); } catch { frame.focus(); }
    } else btn.focus();
  }

  function build() {
    var lang = cfg.defaultLanguage === "bn" ? "bn" : "en", sd = side();
    btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", LABEL[lang]);
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-haspopup", "dialog");
    css(btn, { position: "fixed", bottom: "20px", height: "56px", padding: "0 22px 0 9px", borderRadius: "28px", border: "1px solid #e4e5ea", background: "#fff", color: "#1c1d22", display: "flex", alignItems: "center", gap: "11px",
      font: "650 15px/1 " + FONT, cursor: "pointer", zIndex: "2147483000", margin: "0", boxShadow: "0 10px 28px -8px rgba(28,29,34,.28),0 2px 6px rgba(28,29,34,.08)" });
    btn.style[sd] = "20px";
    if (!reduce) btn.style.transition = "transform .2s " + EASE + ",box-shadow .2s " + EASE;
    var m = mark(40, 16);
    m.style.overflow = "visible";
    badge = document.createElement("span");
    badge.setAttribute("aria-hidden", "true");
    css(badge, { position: "absolute", top: "-3px", right: "-3px", minWidth: "18px", height: "18px", boxSizing: "border-box", borderRadius: "9px", background: "#d9363e", color: "#fff", font: "700 11px/1 " + FONT, display: "none", alignItems: "center", justifyContent: "center", border: "2px solid #fff", padding: "0 4px" });
    m.appendChild(badge);
    var label = document.createElement("span");
    label.textContent = LABEL[lang];
    btn.appendChild(m); btn.appendChild(label);
    btn.addEventListener("mouseenter", function () { css(btn, { transform: "translateY(-2px)", boxShadow: "0 14px 32px -8px rgba(28,29,34,.34),0 2px 6px rgba(28,29,34,.08)" }); });
    btn.addEventListener("mouseleave", function () { css(btn, { transform: "none", boxShadow: "0 10px 28px -8px rgba(28,29,34,.28),0 2px 6px rgba(28,29,34,.08)" }); });
    focusRing(btn);
    btn.addEventListener("click", function () { toggle(); });

    box = document.createElement("div");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", (lang === "bn" ? "চ্যাট: " : "Chat with ") + cfg.name);
    box.hidden = true;
    css(box, { position: "fixed", zIndex: "2147483001", overflow: "hidden", background: "#fff", margin: "0", boxSizing: "border-box", boxShadow: "0 28px 64px -16px rgba(28,29,34,.36),0 3px 10px rgba(28,29,34,.08)" });
    if (!reduce) box.style.transition = "height .3s " + EASE;

    // Created hidden as soon as /config succeeded, so the chat can report unread agent replies while the panel is closed (it cannot be read from here, it tells us by postMessage).
    frame = document.createElement("iframe");
    frame.title = "Chat";
    frame.src = base + "/widget/" + key + "?host=" + encodeURIComponent(location.origin) + (grant ? "&preview=" + encodeURIComponent(grant) : "");
    frame.setAttribute("allow", "");
    css(frame, { border: "0", width: "100%", height: "100%", display: "block", colorScheme: "light" });
    frame.addEventListener("load", function () { post({ type: "crm-chat:state", open: open, page: pageUrl() }); });
    box.appendChild(frame);

    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && open) toggle(false); });
    window.addEventListener("resize", layout);
    window.addEventListener("message", function (e) {
      // Only our own iframe, from our own origin. Anything else (other frames, other scripts) is ignored.
      if (e.origin !== base || !frame || e.source !== frame.contentWindow || !e.data) return;
      var d = e.data;
      if (d.type === "crm-chat:close") toggle(false);
      else if (d.type === "crm-chat:unread" && typeof d.n === "number" && isFinite(d.n)) { if (!open) setBadge(d.n); }
      else if (d.type === "crm-chat:height" && typeof d.h === "number" && isFinite(d.h)) { want = d.h; layout(); }
      else if (d.type === "crm-chat:page?") post({ type: "crm-chat:page", page: pageUrl() }); // asked just before each send, so the page is the current one in a single page app
    });
    function mount() { document.body.appendChild(box); document.body.appendChild(btn); layout(); anim(btn, [{ opacity: 0, transform: "translateY(14px) scale(.96)" }, { opacity: 1, transform: "none" }], 600, 350); }
    if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
  }

  // Ask the chat server first: a site that is not allowed for this key gets no launcher at all (the browser hides the 403 behind a CORS error, so any failure reads the same).
  fetch(base + "/public/widget/" + key + "/config", grant ? { headers: { "x-widget-preview": grant } } : {}).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; }).then(function (c) {
    if (!c) return console.warn("Chat widget not shown: this site's origin is not allowed for this widget key");
    if (!c.enabled) console.warn("Chat widget is switched off in Social CRM: visitors see the offline message");
    cfg = c;
    if (!/^#[0-9a-fA-F]{6}$/.test(cfg.color || "")) cfg.color = "#2563eb";
    if (typeof cfg.avatarUrl !== "string" || !/^https:\/\//.test(cfg.avatarUrl)) cfg.avatarUrl = null;
    build();
  });
})();
