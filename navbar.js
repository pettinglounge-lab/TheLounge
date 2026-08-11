// Navbar.js
// Reusable navigation bar. Include this script on any page, then place
// <site-nav></site-nav> where you want the bar. All styling lives in style.css
// (the .nav classes), so change the look there and every page updates.
//
// Optional: mark the current page, e.g. <site-nav active="gallery"></site-nav>

class SiteNav extends HTMLElement {
  connectedCallback() {
    const active = this.getAttribute("active") || "";
    const on = (name) => (active === name ? "active" : "");

    this.innerHTML = `
      <header class="nav">
        <a class="brand" href="index.html"><span class="dot"></span>Northlight Studio</a>
        <nav class="links">
          <a href="customize.html"   class="${on("portraits")}">Portraits</a>
          <a href="how-it-works.html" class="${on("how")}">How it works</a>
          <a href="gallery.html"      class="${on("gallery")}">Gallery</a>
          <a href="cart.html" class="cart">Cart</a>
        </nav>
      </header>
    `;
  }
}

customElements.define("site-nav", SiteNav);
