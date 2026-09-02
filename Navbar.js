// Navbar.js
// Reusable navigation bar for Petting Lounge. Include on any page with:
//     <site-nav></site-nav>
//     <script type="module" src="Navbar.js"></script>
// Styling lives in style.css (the .nav classes).
//
// Layout:  Petting Lounge | Create ▾ · Gallery · Custom | account
//   - "Create" ▾ -> Pet (index.html), Home (home.html), Memory (memories.html)
//   - "Gallery"  -> gallery.html
//   - "Custom"   -> projects.html
//   - right link -> "Account" (account.html) if signed in, else "Sign up" (signup.html)
//
// Highlight the current page with <site-nav active="..."> using one of:
//   pets | home | memories | create   (all highlight the Create button)
//   gallery | projects

import { supabase } from "./supabaseClient.js";

class SiteNav extends HTMLElement {
  async connectedCallback() {
    this.render(false);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const isRealAccount = !!session && session.user.is_anonymous === false;
      this.render(isRealAccount);
    } catch (e) { /* stay signed-out on error */ }

    // Close the dropdown when clicking anywhere else on the page.
    document.addEventListener("click", () => this.closeMenu());
  }

  render(isRealAccount) {
    const active = this.getAttribute("active") || "";
    const on = (name) => (active === name ? "active" : "");
    const createActive = ["create", "pets", "home", "memories"].includes(active) ? "active" : "";

    const accountHref  = isRealAccount ? "account.html" : "signup.html";
    const accountLabel = isRealAccount ? "Account"      : "Sign up";

    this.innerHTML = `
      <header class="nav">
        <a class="brand" href="index.html">Petting Lounge</a>

        <nav class="center">
          <div class="dropdown">
            <button class="drop-toggle ${createActive}" aria-haspopup="true" aria-expanded="false">
              Create <span class="caret">▾</span>
            </button>
            <div class="menu">
              <a href="pet.html">Pet</a>
              <a href="home.html">Home</a>
              <a href="memories.html">Memory</a>
            </div>
          </div>

          <a href="gallery.html"  class="${on("gallery")}">Gallery</a>
          <a href="projects.html" class="${on("projects")}">Custom</a>
        </nav>

        <div class="account">
          <a href="${accountHref}">${accountLabel}</a>
        </div>
      </header>
    `;

    // Toggle the dropdown on click (needed for touch; hover covers desktop).
    const toggle = this.querySelector(".drop-toggle");
    if (toggle) {
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        const dd = this.querySelector(".dropdown");
        const open = dd.classList.toggle("open");
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
      });
    }
  }

  closeMenu() {
    const dd = this.querySelector(".dropdown");
    if (dd) dd.classList.remove("open");
    const t = this.querySelector(".drop-toggle");
    if (t) t.setAttribute("aria-expanded", "false");
  }
}

customElements.define("site-nav", SiteNav);
