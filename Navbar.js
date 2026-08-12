// Navbar.js
// Reusable navigation bar for Petting Lounge. Include on any page with:
//     <site-nav></site-nav>
//     <script type="module" src="Navbar.js"></script>
// Styling lives in style.css (the .nav classes).
//
// Layout:  Petting Lounge | Pets · Home · Memories · My Projects | account
//   - "Pets"        -> index.html     (pet portraits)
//   - "Home"        -> home.html      (house portraits)
//   - "Memories"    -> memories.html  (keepsake / tribute portraits)
//   - "My Projects" -> projects.html
//   - right link    -> "Account" (account.html) if signed in, else "Sign up" (signup.html)
//
// Mark the current page with e.g. <site-nav active="pets"></site-nav>

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

    const accountHref  = isRealAccount ? "account.html" : "signup.html";
    const accountLabel = isRealAccount ? "Account"      : "Sign up";

    this.innerHTML = `
      <header class="nav">
        <a class="brand" href="index.html">Petting Lounge</a>

        <nav class="center">
          <a href="index.html"     class="${on("pets")}">Pets</a>
          <a href="home.html"      class="${on("home")}">Home</a>
          <a href="memories.html"  class="${on("memories")}">Memories</a>
          <a href="projects.html"  class="${on("projects")}">My Projects</a>
        </nav>

        <div class="account">
          <a href="${accountHref}">${accountLabel}</a>
        </div>
      </header>
    `;
  }
}

customElements.define("site-nav", SiteNav);
