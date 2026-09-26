
    import { supabase } from "./supabaseClient.js";
    import { GENERATION_COST, canAffordGeneration, creditBalanceText, dailyCreditAllowance, getDailyCredits, initializeCreditProfile, creditStatusText } from "./credits.js";

    import { generatePreview } from "./preview-request.js";

    await initializeCreditProfile();

    const CATEGORY = "pet";
    const selectedStyle = "Custom";
    let productsByType = {};
    async function init() {
      const { data, error } = await supabase.from("products").select("*").eq("category", CATEGORY);
      if (error) throw error;
      (data || []).forEach(product => { productsByType[product.product_type] = product; });
    }

    // ---- refs ----
    const overlay  = document.getElementById("overlay");
    const artworkPreview  = document.getElementById("artwork-preview");
    const mpLoad   = document.getElementById("mp-loading");
    const drop     = document.getElementById("drop");
    const fileIn   = document.getElementById("file");
    const fname    = document.getElementById("fname");
    const artPrompt = document.getElementById("artPrompt");
    const genBtn   = document.getElementById("generate");
    const postgen  = document.getElementById("postgen");
    const continueBtn = document.getElementById("continue");
    const regenBtn = document.getElementById("regen");
    const msg      = document.getElementById("msg");
    const attempts = document.getElementById("attempts");
    const mTitle   = document.getElementById("modal-title");
    const mSub     = document.getElementById("modal-sub");

    let selectedProduct = null;
    let selectedImg = null;
    let selectedFile = null;
    let scaledDataUrl = null;
    let previewUrl = null;

    // ---- open modal (product is already chosen by which tile they clicked) ----
    document.querySelector(".catalog-grid").addEventListener("click", async (e) => {
      const tile = e.target.closest(".catalog-product"); if (!tile) return;
      tile.disabled = true;
      try { await init(); }
      catch { alert("Unable to load this product. Please try again."); return; }
      finally { tile.disabled = false; }
      const product = productsByType[tile.dataset.type];
      if (!product || !product.available || !(product.variants || []).length) {
        alert("This product is currently unavailable. Please try another."); return;
      }
      openModal(product, tile.dataset.img);
    });

    function openModal(product, img) {
      selectedProduct = product;
      selectedImg = img;
      resetModal();
      mTitle.textContent = product.title || "Custom Pet Portrait";
      mSub.textContent = "Printed & shipped";
      overlay.classList.add("open");
    }

    function showProductSketch() {
      artworkPreview.src = selectedImg;
      artworkPreview.style.display = "block";
    }

    function resetModal() {
      selectedFile = null; scaledDataUrl = null; previewUrl = null;
      fileIn.value = ""; artPrompt.value = "";
      showCredits();
      drop.classList.remove("has-file"); fname.textContent = "";
      msg.textContent = ""; msg.className = "msg"; attempts.textContent = "";
      genBtn.style.display = "block"; genBtn.disabled = false; genBtn.textContent = "Generate preview";
      postgen.style.display = "none"; mpLoad.style.display = "none";
      showProductSketch();
    }

    function closeModal() { overlay.classList.remove("open"); }
    document.getElementById("close").addEventListener("click", closeModal);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

    // ---- file pick ----
    drop.addEventListener("click", () => fileIn.click());
    drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileIn.click(); } });
    ["dragover", "dragenter"].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
    ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
    drop.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) pick(e.dataTransfer.files[0]); });
    fileIn.addEventListener("change", (e) => { if (e.target.files[0]) pick(e.target.files[0]); });

    function pick(file) {
      if (!file.type.startsWith("image/")) { alert("Please choose an image file."); return; }
      selectedFile = file; scaledDataUrl = null; previewUrl = null;
      drop.classList.add("has-file"); fname.textContent = "✓ " + file.name;
      genBtn.style.display = "block"; postgen.style.display = "none";
      msg.textContent = ""; attempts.textContent = "";
      showProductSketch();
      showCredits();
    }

    // ---- shared daily credits ----
    function showCredits() {
      attempts.textContent = creditStatusText();
    }

    window.addEventListener("credits-changed", showCredits);

    // ---- generate ----
    async function generate() {
      msg.textContent = ""; msg.className = "msg";
      if (!selectedFile) { msg.textContent = "Please upload a photo first."; msg.className = "msg err"; return; }

      setLoading(true);
      try {
        if (!scaledDataUrl) scaledDataUrl = await fileToScaledDataUrl(selectedFile, 1280);
        const blob = dataURLtoBlob(scaledDataUrl);
        const fd = new FormData();
        fd.append("image", blob, "photo.jpg");
        fd.append("productType", CATEGORY);
        fd.append("style", selectedStyle);
        fd.append("note", artPrompt.value.trim());

        const data = await generatePreview(fd);

        previewUrl = data.previewUrl;
        artworkPreview.src = previewUrl;
        artworkPreview.alt = "Your generated artwork";
        artworkPreview.style.display = "block";

        const balance = getDailyCredits();
        genBtn.style.display = "none";
        postgen.style.display = "block";
        if (balance && balance.remaining >= GENERATION_COST) { regenBtn.style.display = "block"; regenBtn.disabled = false; regenBtn.textContent = `Regenerate (${GENERATION_COST} credits)`; }
        else { regenBtn.style.display = "none"; }
        showCredits();
      } catch (e) {
        msg.textContent = "Couldn't generate: " + (e.message || e); msg.className = "msg err";
      } finally { setLoading(false); }
    }
    genBtn.addEventListener("click", generate);
    regenBtn.addEventListener("click", generate);

    function setLoading(on) {
      artPrompt.disabled = on;
      mpLoad.style.display = on ? "flex" : "none";
      genBtn.disabled = on; regenBtn.disabled = on; continueBtn.style.pointerEvents = on ? "none" : "auto";
    }

    // ---- continue to checkout: carries the CHOSEN PRODUCT + the approved art.
    //      Frame color, size, and price are resolved next, at checkout. ----
    continueBtn.addEventListener("click", () => {
      const order = {
        category: CATEGORY,
        style: selectedStyle,
        prompt: artPrompt.value.trim(),
        product_type: selectedProduct.product_type,
        printify_product_id: selectedProduct.printify_product_id,
        blueprint_id: selectedProduct.blueprint_id,
        print_provider_id: selectedProduct.print_provider_id,
        title: selectedProduct.title,
        productImg: selectedImg,
      };
      sessionStorage.setItem("ptl_order", JSON.stringify(order));
      sessionStorage.setItem("ptl_photo", scaledDataUrl);
      sessionStorage.setItem("ptl_preview", previewUrl);
      window.location.href = "checkout.html";
    });

    // ---- helpers ----
    function fileToScaledDataUrl(file, maxDim) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const img = new Image();
          img.onload = () => {
            let { width, height } = img;
            if (width > maxDim || height > maxDim) { const r = Math.min(maxDim / width, maxDim / height); width = Math.round(width * r); height = Math.round(height * r); }
            const canvas = document.createElement("canvas");
            canvas.width = width; canvas.height = height;
            canvas.getContext("2d").drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL("image/jpeg", 0.85));
          };
          img.onerror = reject; img.src = reader.result;
        };
        reader.onerror = reject; reader.readAsDataURL(file);
      });
    }
    function dataURLtoBlob(dataUrl) {
      const [head, b64] = dataUrl.split(",");
      const mime = head.match(/:(.*?);/)[1];
      const bin = atob(b64); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: mime });
    }

    artPrompt.addEventListener("input", () => {
      previewUrl = null;
      genBtn.style.display = "block";
      postgen.style.display = "none";
    });
