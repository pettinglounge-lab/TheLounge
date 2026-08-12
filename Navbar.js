// Navbar.js
// Reusable navigation bar for Petting Lounge. Include on any page with:
//     <site-nav></site-nav>
//     <script type="module" src="Navbar.js"></script>
// Styling lives in style.css (the .nav classes).
//
// Layout:  Petting Lounge (logo) | Pet · Home · Projects (center) | account (right)
// Behavior:
//   - "Pet"      -> index.html   (pet portraits)
//   - "Home"     -> home.html    (house portraits)
//   - "Projects" -> projects.html if signed in, else login.html
//   - right link -> "Account" (account.html) if signed in, else "Sign up" (signup.html)
//
// Mark the current page with e.g. <site-nav active="pet"></site-nav>

import { supabase } from "./supabaseClient.js";

class SiteNav extends HTMLElement {
  async connectedCallback() {
    this.render(false);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const isRealAccount = !!session && session.user.is_anonymous === false;
      this.render(isRealAccount);
    } catch (e) { /* stay signed-out on error */ }
  }

  render(isRealAccount) {
    const active = this.getAttribute("active") || "";
    const on = (name) => (active === name ? "active" : "");

    const projectsHref = isRealAccount ? "projects.html" : "login.html";
    const accountHref  = isRealAccount ? "account.html"  : "signup.html";
    const accountLabel = isRealAccount ? "Account"       : "Sign up";

    this.innerHTML = `
      <header class="nav">
        <a class="brand" href="index.html">Petting Lounge</a>

        <nav class="center">
          <a href="index.html"      class="${on("pet")}">Pet</a>
          <a href="home.html"       class="${on("home")}">Home</a>
          <a href="${projectsHref}" class="${on("projects")}">Projects</a>
        </nav>

        <div class="account">
          <a href="${accountHref}">${accountLabel}</a>
        </div>
      </header>
    `;
  }
}

customElements.define("site-nav", SiteNav);
