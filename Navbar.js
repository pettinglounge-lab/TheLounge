// Navbar.js
// Reusable navigation bar for Petting Lounge. Include on any page with:
//     <site-nav></site-nav>
//     <script type="module" src="Navbar.js"></script>
// Styling lives in style.css (the .nav classes).
//
// Layout:  Petting Lounge (logo, left) | Create · Projects (center) | Account (right)
// Behavior:
//   - "Create"  -> index.html (the products / create page)
//   - "Projects"-> projects.html if signed in, otherwise login.html
//   - right link-> "Account" (account.html) if signed in, else "Sign up" (login.html)
//
// Mark the current page with e.g. <site-nav active="create"></site-nav>

import { supabase } from "./supabaseClient.js";

class SiteNav extends HTMLElement {
  async connectedCallback() {
    // 1. Render immediately in the signed-out state so the bar always shows,
    //    even if the auth check is slow or fails.
    this.render(false);

    // 2. Check whether this is a real signed-up account, then adjust links.
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const isRealAccount = !!session && session.user.is_anonymous === false;
      this.render(isRealAccount);
    } catch (e) {
      // stay in signed-out state if anything goes wrong
    }
  }

  render(isRealAccount) {
    const active = this.getAttribute("active") || "";
    const on = (name) => (active === name ? "active" : "");

    const projectsHref = isRealAccount ? "projects.html" : "login.html";
    const accountHref  = isRealAccount ? "account.html"  : "login.html";
    const accountLabel = isRealAccount ? "Account"       : "Sign up";

    this.innerHTML = `
      <header class="nav">
        <a class="brand" href="index.html">Petting Lounge</a>

        <nav class="center">
          <a href="index.html"        class="${on("create")}">Create</a>
          <a href="${projectsHref}"   class="${on("projects")}">Projects</a>
        </nav>

        <div class="account">
          <a href="${accountHref}">${accountLabel}</a>
        </div>
      </header>
    `;
  }
}

customElements.define("site-nav", SiteNav);
