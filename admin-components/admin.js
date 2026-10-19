(function () {
  const config = window.MarketConfig;
  const state = window.MarketState;

  const panelByTab = {
    market: "marketPanel",
    packing: "packingPanel",
    finance: "financePanel",
    itemsList: "itemsListPanel",
    items: "itemsPanel",
    shops: "shopsPanel"
  };

  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (result && result.success === false) throw new Error(result.error || result.message || "คำขอไม่สำเร็จ");
    return result;
  }

  function postAction(payload) {
    return requestJson(config.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });
  }

  // โหลดคอมโพเนนต์ย่อย tab-market, tab-packing, tab-items, tab-shops
  async function loadComponents() {
    const htmlModules = ["market", "packing", "items", "shops"];
    await Promise.all(htmlModules.map(async tab => {
      const response = await fetch(`admin-components/tab-${tab}.html`);
      if (!response.ok) throw new Error(`โหลดคอมโพเนนต์ ${tab} ไม่สำเร็จ`);
      document.getElementById(panelByTab[tab]).innerHTML = await response.text();
    }));
  }

  function initializeDate() {
    const date = new Date();
    document.getElementById("selectedDate").value = 
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  // โหลดออเดอร์
  async function loadOrders() {
    const date = document.getElementById("selectedDate").value;
    const container = document.getElementById("customerCardsContainer");
    if (container) container.innerHTML = '<div class="text-center py-10 text-gray-400">กำลังโหลดข้อมูล...</div>';

    try {
      const data = await requestJson(`${config.APPS_SCRIPT_URL}?action=getAdminOrders&date=${encodeURIComponent(date)}`);
      state.currentOrders = Array.isArray(data.orders) ? data.orders : [];
      renderDashboard();
    } catch (error) {
      state.currentOrders = [];
      renderDashboard();
      console.error("โหลดออเดอร์ไม่สำเร็จ", error);
    }
  }

  // โหลดข้อมูลผักและร้านค้าทั้งหมด
  async function loadInitialData() {
    try {
      const data = await requestJson(`${config.APPS_SCRIPT_URL}?action=getInitialData`);
      if (data.success) {
        state.vegetables = Array.isArray(data.vegetables) ? data.vegetables : [];
        state.allShops = Array.isArray(data.customers) ? data.customers : [];
        renderVegetablesList();
        renderShops();
      }
    } catch (e) {
      console.error("โหลดข้อมูลตั้งต้นไม่สำเร็จ", e);
    }
  }

  // อัปเดตกล่องสรุปการเงินในแท็บ finance
  function updateFinanceStats(orders) {
    const totalShops = orders.length;
    let paidShopsCount = 0;
    let paidAmount = 0;
    let unpaidShopsCount = 0;
    let unpaidAmount = 0;
    const unpaidShopNames = [];

    orders.forEach(order => {
      const orderTotal = (order.items || []).reduce((sum, item) => {
        const qty = Number(item.qty) || 0;
        const price = Number(item.unitPrice) || 0;
        return sum + (qty * price);
      }, 0);

      if (order.paymentStatus === "ชำระแล้ว") {
        paidShopsCount++;
        paidAmount += orderTotal;
      } else {
        unpaidShopsCount++;
        unpaidAmount += orderTotal;
        unpaidShopNames.push(order.customerName);
      }
    });

    const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setTxt("statTotalShops", totalShops);
    setTxt("statTotalShopsCard", totalShops);
    setTxt("statPaidShops", paidShopsCount);
    setTxt("statPaidAmount", paidAmount.toLocaleString());
    setTxt("statUnpaidShops", unpaidShopsCount);
    setTxt("statUnpaidAmount", unpaidAmount.toLocaleString());
    setTxt("statUnpaidList", unpaidShopNames.length > 0 ? unpaidShopNames.join(", ") : "ไม่มีร้านค้างชำระ");
  }

  function renderDashboard() {
    renderMarketTab();
    renderPackingTab();
  }

  function renderMarketTab() {
    const list = document.getElementById("summaryList");
    if (!list) return;
    if (!state.currentOrders.length) {
      list.innerHTML = '<div class="text-center py-10 text-gray-400 bg-white rounded-2xl border p-6">ไม่มีรายการสั่งซื้อสำหรับวันที่เลือก</div>';
      const addonSec = document.getElementById("addonSection");
      if (addonSec) addonSec.classList.add("hidden");
      updateFinanceStats([]);
      return;
    }

    const totals = new Map();
    const addons = [];
    state.currentOrders.forEach(order => {
      if (order.addOnNote && order.addOnNote.trim()) {
        addons.push({ shop: order.customerName, note: order.addOnNote });
      }
      (Array.isArray(order.items) ? order.items : []).forEach(item => {
        const key = JSON.stringify([item.name, item.unit]);
        const current = totals.get(key) || { key, name: item.name, unit: item.unit, qty: 0, shops: [] };
        const qty = Number(item.qty) || 0;
        current.qty += qty;
        current.shops.push(`${order.customerName} (${qty})`);
        totals.set(key, current);
      });
    });

    const addonSection = document.getElementById("addonSection");
    if (addonSection) {
      addonSection.classList.toggle("hidden", addons.length === 0);
      document.getElementById("addonList").innerHTML = addons.map(addon => `
        <div class="bg-white/90 p-2.5 rounded-xl border border-amber-200 text-xs text-amber-950">
          <strong class="text-amber-900">🏪 ${escapeHtml(addon.shop)}:</strong>
          <div class="text-sm font-semibold">${escapeHtml(addon.note)}</div>
        </div>`).join("");
    }

    list.innerHTML = [...totals.values()].map(item => {
      const bought = state.boughtItems.has(item.key);
      return `<button data-action="toggle-bought" data-key="${escapeHtml(item.key)}" class="w-full text-left p-3.5 rounded-2xl border-2 flex items-center justify-between gap-3 shadow-sm ${bought ? "checked-box bg-gray-50 border-gray-200" : "bg-white border-gray-200"}">
        <span class="flex items-center gap-3">
          <input type="checkbox" ${bought ? "checked" : ""} tabindex="-1" class="w-6 h-6 rounded text-emerald-600 pointer-events-none">
          <span><strong class="block text-lg ${bought ? "line-through text-gray-400" : "text-gray-900"}">${escapeHtml(item.name)}</strong>
          <small class="text-gray-500">ร้านที่สั่ง: ${escapeHtml(item.shops.join(", "))}</small></span>
        </span>
        <span class="text-right whitespace-nowrap"><strong class="text-2xl text-emerald-700 ${bought ? "line-through text-gray-400" : ""}">${escapeHtml(item.qty)}</strong><small class="block text-gray-600">${escapeHtml(item.unit)}</small></span>
      </button>`;
    }).join("") || '<div class="text-center py-8 text-gray-400">ไม่มีรายการผัก</div>';
  }

  function formatOrderTime(timestamp) {
    if (!timestamp) return "ไม่ระบุเวลา";
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return String(timestamp);
    return `${date.getDate()} ${date.toLocaleDateString("th-TH", { month: "short" })} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")} น.`;
  }

  function renderPackingTab() {
    const container = document.getElementById("customerCardsContainer");
    if (!container) return;

    const orders = state.currentOrders.map(order => {
      const items = Array.isArray(order.items) ? order.items : [];
      const checked = items.reduce((count, item, index) =>
        count + (state.packedItems[`${order.orderId}_${index}`] ? 1 : 0), 0);
      return { ...order, items, checked, remaining: items.length - checked, done: items.length > 0 && checked === items.length };
    }).sort((a, b) => Number(a.done) - Number(b.done));

    const completed = orders.filter(order => order.done).length;
    const statCompleted = document.getElementById("statCompletedShops");
    if (statCompleted) statCompleted.textContent = completed;

    updateFinanceStats(orders);

    if (!orders.length) {
      container.innerHTML = '<div class="text-center py-10 text-gray-400 bg-white rounded-2xl border p-6">ไม่มีรายการสั่งซื้อสำหรับวันที่เลือก</div>';
      return;
    }

    container.innerHTML = orders.map(order => {
      const status = order.items.length === 0 ? "ไม่มีรายการ" :
        order.done ? `✓ ครบแล้ว (${order.checked}/${order.items.length})` :
          order.checked ? `⚠️ ค้าง ${order.remaining} รายการ (${order.checked}/${order.items.length})` :
            `⏳ ยังไม่ได้ของ (${order.items.length})`;

      return `<article class="rounded-2xl border-2 p-4 shadow-sm space-y-3 ${order.done ? "bg-gray-50 opacity-80" : order.checked ? "bg-amber-50/40 border-amber-400" : "bg-white border-gray-200"}">
        <div class="flex justify-between items-start border-b pb-2.5 gap-2">
          <div><h3 class="font-extrabold text-lg">🏪 ${escapeHtml(order.customerName)}</h3>
            <div class="text-[11px] text-emerald-800">🕐 สั่ง: ${escapeHtml(formatOrderTime(order.timestamp))} · รหัส: ${escapeHtml(order.orderId)}</div></div>
          <span class="shrink-0 text-xs font-bold">${status}</span>
        </div>
        <div class="space-y-2">${order.items.map((item, index) => {
          const key = `${order.orderId}_${index}`;
          const checked = !!state.packedItems[key];
          const edited = item.originalQty !== undefined && Number(item.originalQty) !== Number(item.qty);
          return `<div class="p-3 rounded-xl border flex items-center justify-between gap-2 ${checked ? "bg-emerald-100/60 border-emerald-400" : "bg-gray-50 border-gray-200"}">
            <label class="flex items-center gap-3 flex-1 cursor-pointer">
              <input type="checkbox" data-action="toggle-packed" data-order="${escapeHtml(order.orderId)}" data-index="${index}" ${checked ? "checked" : ""} class="w-5 h-5 rounded text-emerald-600">
              <span><strong class="text-base ${checked ? "line-through text-gray-500" : ""}">${escapeHtml(item.name)}</strong>${edited ? `<small class="block text-[11px] text-amber-700 font-semibold">แม่ปรับยอด · เดิมสั่ง <span class="line-through">${escapeHtml(item.originalQty)}</span> → ได้ ${escapeHtml(item.qty)} ${escapeHtml(item.unit)}</small>` : ""}</span>
            </label>
            <span class="font-extrabold whitespace-nowrap">${escapeHtml(item.qty)}${escapeHtml(item.unit)}</span>
            <button data-action="edit-qty" data-order="${escapeHtml(order.orderId)}" data-index="${index}" class="p-1.5 bg-white border rounded-lg" title="ปรับจำนวน">✏️</button>
          </div>`;
        }).join("")}</div>
        ${order.addOnNote ? `<div class="p-2.5 bg-amber-50 rounded-xl border border-amber-200 text-xs"><strong>📝 สั่งพิเศษ:</strong> ${escapeHtml(order.addOnNote)}</div>` : ""}
      </article>`;
    }).join("");
  }

// ==============================================
  // 5. เรนเดอร์คลังผักทั้งหมด (ปรับแต่ง UI ให้สวยงาม ชัดเจน)
  // ==============================================
  function getVegStatus(vegetable) {
    return String(vegetable.status || "ACTIVE").trim().toUpperCase() === "HIDDEN" ? "HIDDEN" : "ACTIVE";
  }

  function renderVegetablesList() {
    const container = document.getElementById("allVegetablesContainer");
    if (!container) return;

    const activeCount = state.vegetables.filter(vegetable => getVegStatus(vegetable) === "ACTIVE").length;
    const hiddenCount = state.vegetables.length - activeCount;
    const activeCountEl = document.getElementById("activeItemCount");
    const hiddenCountEl = document.getElementById("hiddenItemCount");
    if (activeCountEl) activeCountEl.textContent = activeCount;
    if (hiddenCountEl) hiddenCountEl.textContent = hiddenCount;

    const query = (document.getElementById("searchItemInput")?.value || "").trim().toLowerCase();

    // จัดเรียง: สินค้าที่ ACTIVE ขึ้นก่อน -> สินค้าที่ HIDDEN ลงไปล่างสุด
    const filtered = state.vegetables
      .slice()
      .sort((a, b) => getVegStatus(a).localeCompare(getVegStatus(b)))
      .filter(v => `${v.name} ${v.id} ${v.unit}`.toLowerCase().includes(query));

    if (!filtered.length) {
      container.innerHTML = '<div class="col-span-full text-center py-10 text-gray-400 bg-white rounded-2xl border p-6">ไม่พบรายการผัก</div>';
      return;
    }

    container.innerHTML = filtered.map(v => {
      const isHidden = getVegStatus(v) === "HIDDEN";
      const toggling = state.togglingVegIds && state.togglingVegIds.has(String(v.id));
      let imgSrc = '';
      if (v.image) {
        imgSrc = v.image.startsWith('http') ? v.image : `images/${v.image}`;
      }

      return `
        <div class="bg-white p-3 rounded-2xl border shadow-sm flex items-center justify-between gap-3 transition-all ${isHidden ? "bg-gray-50/80 border-dashed border-gray-300 opacity-60" : "border-gray-200"}">
          <div class="flex items-center gap-3 min-w-0 flex-1">
            <div class="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center overflow-hidden shrink-0 border border-gray-200">
              ${imgSrc ? `<img src="${imgSrc}" onerror="this.outerHTML='<span class=\\'text-2xl\\'>🥬</span>'" class="w-full h-full object-cover">` : '<span class="text-2xl">🥬</span>'}
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1 min-w-0">
                <h4 class="font-extrabold text-sm text-gray-900 truncate leading-snug">${escapeHtml(v.name)}</h4>
                ${isHidden ? '<span class="text-[9px] font-bold bg-amber-100 text-amber-800 px-1 py-0.5 rounded shrink-0">ซ่อน</span>' : '<span class="text-[9px] font-bold bg-emerald-100 text-emerald-800 px-1 py-0.5 rounded shrink-0">ขาย</span>'}
              </div>
              <p class="text-[11px] text-gray-500 mt-0.5 truncate">หน่วย: <span class="font-bold text-emerald-800">${escapeHtml(v.unit)}</span> · <span class="font-mono text-[9px] text-gray-400">${escapeHtml(v.id)}</span></p>
            </div>
          </div>

          <div class="flex flex-col items-end gap-1 shrink-0">
            <div class="flex items-center gap-1">
              <button data-action="edit-veg" data-veg-id="${escapeHtml(v.id)}" data-veg-name="${escapeHtml(v.name)}" data-veg-unit="${escapeHtml(v.unit)}"
              class="w-7 h-7 flex items-center justify-center bg-gray-100 hover:bg-emerald-100 text-gray-600 hover:text-emerald-800 rounded-lg text-xs shrink-0" title="แก้ไข">
              ✏️
            </button>
              <button data-action="delete-veg" data-veg-id="${escapeHtml(v.id)}" data-veg-name="${escapeHtml(v.name)}"
              class="w-7 h-7 flex items-center justify-center bg-gray-100 hover:bg-red-100 text-gray-400 hover:text-red-600 rounded-lg text-xs shrink-0" title="ลบ">
              🗑️
            </button>
            </div>
            <button data-action="toggle-veg-visibility" data-veg-id="${escapeHtml(v.id)}"
              class="px-1.5 py-1 rounded-lg text-[10px] font-bold transition flex items-center justify-center gap-1 whitespace-nowrap ${isHidden ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-gray-100 text-gray-700 hover:bg-amber-100 hover:text-amber-900'}"
              ${toggling ? "disabled" : ""} title="${isHidden ? 'เปิดแสดงในร้าน' : 'ซ่อนชั่วคราว'}">
              ${toggling ? "กำลังบันทึก..." : isHidden ? "👁️ แสดง" : "🚫 ซ่อน"}
            </button>
          </div>
        </div>
      `;
    }).join("");
  }

  async function toggleVegVisibility(id) {
    const vegetable = state.vegetables.find(item => String(item.id) === String(id));
    if (!vegetable) return;
    state.togglingVegIds = state.togglingVegIds || new Set();
    const key = String(id);
    if (state.togglingVegIds.has(key)) return;

    const previousStatus = getVegStatus(vegetable);
    const nextStatus = previousStatus === "ACTIVE" ? "HIDDEN" : "ACTIVE";
    vegetable.status = nextStatus;
    state.togglingVegIds.add(key);
    renderVegetablesList();

    try {
      const result = await postAction({ action: "toggleItemStatus", itemId: id, status: nextStatus });
      if (result.success !== true || result.status !== nextStatus) {
        throw new Error(result.message || "Apps Script ไม่ยืนยันการเปลี่ยนสถานะสินค้า");
      }
    } catch (error) {
      vegetable.status = previousStatus;
      alert(`เปลี่ยนสถานะสินค้าไม่สำเร็จ: ${error.message}`);
    } finally {
      state.togglingVegIds.delete(key);
      renderVegetablesList();
    }
  }

  function openEditVegModal(id, name, unit) {
    state.editingVegContext = { id };
    document.getElementById("editVegIdInput").value = id;
    document.getElementById("editVegNameInput").value = name;
    document.getElementById("editVegUnitInput").value = unit;
    const modal = document.getElementById("editVegModal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }

  function closeEditVegModal() {
    const modal = document.getElementById("editVegModal");
    modal.classList.add("hidden");
    modal.classList.remove("flex");
    state.editingVegContext = null;
  }

  async function saveEditVeg() {
    if (!state.editingVegContext) return;
    const id = state.editingVegContext.id;
    const newName = document.getElementById("editVegNameInput").value.trim();
    const newUnit = document.getElementById("editVegUnitInput").value;

    if (!newName) return alert("กรุณาระบุชื่อผัก");

    const btn = document.getElementById("saveEditVegButton");
    btn.disabled = true;
    btn.innerText = "กำลังบันทึก...";

    try {
      await postAction({
        action: "updateItem",
        itemId: id,
        name: newName,
        unit: newUnit
      });

      const target = state.vegetables.find(v => String(v.id) === String(id));
      if (target) {
        target.name = newName;
        target.unit = newUnit;
      }
      renderVegetablesList();
      closeEditVegModal();
      alert("✅ แก้ไขข้อมูลผักเรียบร้อยแล้ว");
    } catch (e) {
      alert("บันทึกไม่สำเร็จ: " + e.message);
    } finally {
      btn.disabled = false;
      btn.innerText = "บันทึก";
    }
  }

  async function deleteVeg(id, name) {
    if (!confirm(`ยืนยันการลบ "${name}" ออกจากคลังผักหรือไม่?`)) return;

    try {
      await postAction({ action: "deleteItem", itemId: id });
      state.vegetables = state.vegetables.filter(v => String(v.id) !== String(id));
      renderVegetablesList();
      alert(`✓ ลบ "${name}" ออกจากระบบแล้ว`);
    } catch (e) {
      alert("ลบไม่สำเร็จ: " + e.message);
    }
  }

  // ==============================================
  // สลับโหมดหลัก (หน้างานตลาด vs ระบบหลังบ้าน)
  // ==============================================
  function setMainMode(mode) {
    state.mainMode = mode;

    const dailyNav = document.getElementById("dailyNavSection");
    const mgmtNav = document.getElementById("mgmtNavSection");
    const dateBar = document.getElementById("headerDateBar");
    const btnDaily = document.getElementById("mainModeDailyBtn");
    const btnMgmt = document.getElementById("mainModeMgmtBtn");

    if (mode === "daily") {
      dailyNav.classList.remove("hidden");
      mgmtNav.classList.add("hidden");
      dateBar.classList.remove("hidden");

      btnDaily.className = "px-3 py-1.5 rounded-lg bg-white text-emerald-900 shadow transition";
      btnMgmt.className = "px-3 py-1.5 rounded-lg text-emerald-200 hover:text-white transition";

      setActiveTab("market");
    } else {
      dailyNav.classList.add("hidden");
      mgmtNav.classList.remove("hidden");
      dateBar.classList.add("hidden");

      btnMgmt.className = "px-3 py-1.5 rounded-lg bg-white text-emerald-900 shadow transition";
      btnDaily.className = "px-3 py-1.5 rounded-lg text-emerald-200 hover:text-white transition";

      setActiveTab("itemsList"); // เริ่มต้นที่คลังผักทั้งหมด
    }
  }

  function setActiveTab(tab) {
    state.activeTab = tab;

    Object.entries(panelByTab).forEach(([key, panelId]) => {
      const panel = document.getElementById(panelId);
      if (panel) panel.classList.toggle("hidden", key !== tab);
    });

    document.querySelectorAll(".tab-button").forEach(button => {
      const active = button.dataset.tab === tab;
      button.className = `tab-button py-2.5 rounded-xl transition ${active ? "bg-white text-emerald-800 shadow font-bold" : "text-gray-500 font-semibold"}`;
    });

    if (tab === "itemsList") renderVegetablesList();
    if (tab === "shops") renderShops();
  }

  function renderShops() {
    const container = document.getElementById("shopsListContainer");
    if (!container) return;
    const query = (document.getElementById("searchShopInput")?.value || "").trim().toLowerCase();
    const filtered = state.allShops.filter(shop =>
      `${shop.name} ${shop.id} ${shop.contact || ""}`.toLowerCase().includes(query));

    if (!filtered.length) {
      container.innerHTML = '<div class="text-center py-10 text-gray-400 bg-white rounded-2xl border p-6">ไม่พบรายชื่อร้านค้า</div>';
      return;
    }
    container.innerHTML = filtered.map((shop, index) => {
      const link = new URL("index.html", window.location.href);
      link.search = `?id=${encodeURIComponent(shop.id)}`;

      return `
        <article class="bg-white p-3.5 rounded-2xl border shadow-sm flex items-center justify-between gap-2">
          <div class="flex items-center gap-3 min-w-0">
            <span class="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold shrink-0">${index + 1}</span>
            <div class="min-w-0">
              <strong class="block truncate">${escapeHtml(shop.name)}</strong>
              <small class="text-gray-500 font-mono">${escapeHtml(shop.id)}</small> ${shop.contact ? `<small class="text-gray-500"> · 📞 ${escapeHtml(shop.contact)}</small>` : ""}
            </div>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button data-action="copy-shop-link" data-link="${escapeHtml(link.href)}" data-shop-name="${escapeHtml(shop.name)}" class="bg-emerald-600 text-white px-2.5 py-2 rounded-xl text-xs font-bold shadow">📋 LINE</button>
            <button data-action="edit-shop" data-shop-id="${escapeHtml(shop.id)}" class="p-2 bg-gray-100 rounded-xl" title="แก้ไข">✏️</button>
            <button data-action="delete-shop" data-shop-id="${escapeHtml(shop.id)}" class="p-2 bg-red-50 text-red-600 rounded-xl" title="ลบร้าน">🗑️</button>
          </div>
        </article>
      `;
    }).join("");
  }

  function processImageToWebP(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("อ่านรูปภาพไม่สำเร็จ"));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error("เปิดรูปภาพไม่สำเร็จ"));
        image.onload = () => {
          const scale = Math.min(1, 400 / Math.max(image.width, image.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          const context = canvas.getContext("2d");
          if (!context) return reject(new Error("เบราว์เซอร์ไม่รองรับ Canvas"));
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/webp", 0.75);
          resolve(dataUrl.split(",")[1]);
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function saveNewItem() {
    const name = document.getElementById("newItemName").value.trim();
    const unit = document.getElementById("newItemUnit").value;
    if (!name) return alert("กรุณากรอกชื่อสินค้า");
    const button = document.getElementById("saveItemButton");
    const status = document.getElementById("itemStatus");
    button.disabled = true;
    status.classList.add("hidden");

    try {
      const result = await postAction({
        action: "addNewItem",
        name,
        unit,
        base64Image: state.selectedImageBase64
      });

      if (result.success !== true) throw new Error(result.error || "บันทึกสินค้าไม่สำเร็จ");

      status.textContent = `เพิ่มสินค้า "${name}" สำเร็จแล้ว`;
      status.className = "text-sm font-semibold text-emerald-700";
      status.classList.remove("hidden");

      // เพิ่มลงคลังผักหน้าจอ
      state.vegetables.push({ id: result.itemId, name, unit, image: result.imageUrl || "", status: "ACTIVE" });
      renderVegetablesList();

      document.getElementById("newItemName").value = "";
      document.getElementById("itemImageInput").value = "";
      document.getElementById("itemImagePreview").classList.add("hidden");
      document.getElementById("itemImagePrompt").classList.remove("hidden");
      state.selectedImageBase64 = "";
    } catch (error) {
      status.textContent = `บันทึกไม่สำเร็จ: ${error.message}`;
      status.className = "text-sm font-semibold text-red-700";
      status.classList.remove("hidden");
    } finally {
      button.disabled = false;
    }
  }

  // ตัวจัดการคลิกทั้งหมด
  async function handleClick(event) {
    const mainModeBtn = event.target.closest("[data-main-mode]");
    if (mainModeBtn) return setMainMode(mainModeBtn.dataset.mainMode);

    const tabButton = event.target.closest("[data-tab]");
    if (tabButton) return setActiveTab(tabButton.dataset.tab);

    const quickQty = event.target.closest("[data-quick-qty]");
    if (quickQty) {
      document.getElementById("newQtyInput").value = quickQty.dataset.quickQty;
      return;
    }

    const control = event.target.closest("[data-action]");
    if (!control) return;

    switch (control.dataset.action) {
      case "toggle-bought": {
        const key = control.dataset.key;
        state.boughtItems.has(key) ? state.boughtItems.delete(key) : state.boughtItems.add(key);
        localStorage.setItem("market_bought_items", JSON.stringify([...state.boughtItems]));
        renderMarketTab();
        break;
      }
      case "toggle-packed": {
        const key = `${control.dataset.order}_${control.dataset.index}`;
        if (control.checked) state.packedItems[key] = true;
        else delete state.packedItems[key];
        localStorage.setItem("market_packed_items", JSON.stringify(state.packedItems));
        renderPackingTab();
        break;
      }
      case "edit-qty": {
        const order = state.currentOrders.find(item => String(item.orderId) === control.dataset.order);
        const item = order && order.items && order.items[Number(control.dataset.index)];
        if (!item) return;
        state.editingContext = { orderId: control.dataset.order, itemIndex: Number(control.dataset.index) };
        document.getElementById("editVegName").textContent = `ปรับจำนวน: ${item.name}`;
        document.getElementById("editOriginalInfo").textContent = `ลูกค้าสั่ง: ${item.originalQty !== undefined ? item.originalQty : item.qty} ${item.unit}`;
        document.getElementById("editUnitLabel").textContent = item.unit;
        document.getElementById("newQtyInput").value = item.qty;
        document.getElementById("editQtyModal").classList.remove("hidden");
        document.getElementById("editQtyModal").classList.add("flex");
        break;
      }
      case "close-edit-qty": {
        document.getElementById("editQtyModal").classList.add("hidden");
        document.getElementById("editQtyModal").classList.remove("flex");
        state.editingContext = null;
        break;
      }
      case "save-edit-qty": {
        if (!state.editingContext) return;
        const { orderId, itemIndex } = state.editingContext;
        const order = state.currentOrders.find(item => String(item.orderId) === orderId);
        const item = order && order.items && order.items[itemIndex];
        const qty = Number(document.getElementById("newQtyInput").value);
        if (!item || !Number.isFinite(qty) || qty < 0) return alert("กรุณาระบุจำนวนตั้งแต่ 0 ขึ้นไป");
        item.originalQty = item.originalQty !== undefined ? item.originalQty : item.qty;
        item.qty = qty;
        await postAction({ action: "updateOrderItems", orderId, items: order.items });
        document.getElementById("editQtyModal").classList.add("hidden");
        document.getElementById("editQtyModal").classList.remove("flex");
        renderDashboard();
        break;
      }
      // จัดการคลังผัก (แก้ไข/ลบ)
      case "edit-veg":
        openEditVegModal(control.dataset.vegId, control.dataset.vegName, control.dataset.vegUnit);
        break;
      case "close-edit-veg":
        closeEditVegModal();
        break;
      case "save-edit-veg":
        await saveEditVeg();
        break;
      case "delete-veg":
        await deleteVeg(control.dataset.vegId, control.dataset.vegName);
        break;
      case "toggle-veg-visibility":
        await toggleVegVisibility(control.dataset.vegId);
        break;
      case "save-item":
        await saveNewItem();
        break;
      case "copy-shop-link": {
        const link = control.dataset.link;
        try { await navigator.clipboard.writeText(link); alert(`คัดลอกลิงก์ร้าน ${control.dataset.shopName} แล้ว`); }
        catch { window.prompt("คัดลอกลิงก์ส่งทาง LINE:", link); }
        break;
      }
    }
  }

  function initializeEvents() {
    document.body.addEventListener("click", handleClick);
    document.getElementById("refreshButton")?.addEventListener("click", loadOrders);
    document.getElementById("todayButton")?.addEventListener("click", () => {
      initializeDate();
      loadOrders();
    });
    document.getElementById("selectedDate")?.addEventListener("change", loadOrders);

    // ค้นหาในคลังผัก
    document.getElementById("searchItemInput")?.addEventListener("input", renderVegetablesList);
    // ค้นหาร้านค้า
    document.getElementById("adminApp")?.addEventListener("input", event => {
      if (event.target.id === "searchShopInput") renderShops();
    });

    // อัปโหลดรูปภาพ
    document.getElementById("adminApp")?.addEventListener("change", async event => {
      if (event.target.id === "itemImageInput" && event.target.files[0]) {
        try {
          state.selectedImageBase64 = await processImageToWebP(event.target.files[0]);
          const preview = document.getElementById("itemImagePreview");
          preview.src = `data:image/webp;base64,${state.selectedImageBase64}`;
          preview.classList.remove("hidden");
          document.getElementById("itemImagePrompt").classList.add("hidden");
        } catch (error) {
          alert(error.message);
        }
      }
    });
  }

  async function initialize() {
    try {
      initializeDate();
      await loadComponents();
      initializeEvents();
      setMainMode("daily"); // เริ่มที่โหมดหน้างาน
      await Promise.all([loadOrders(), loadInitialData()]);
    } catch (error) {
      console.error("เริ่มต้นระบบไม่สำเร็จ", error);
    }
  }

  initialize();
})();