(function () {
  const config = window.MarketConfig;
  const state = window.MarketState;
  const panelByTab = {
    market: "marketPanel",
    packing: "packingPanel",
    shops: "shopsPanel",
    items: "itemsPanel"
  };

  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (result && result.success === false) throw new Error(result.error || "คำขอไม่สำเร็จ");
    return result;
  }

  function postAction(payload) {
    return requestJson(config.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });
  }

  async function loadComponents() {
    await Promise.all(Object.entries(panelByTab).map(async ([tab, panelId]) => {
      const response = await fetch(`admin-components/tab-${tab}.html`);
      if (!response.ok) throw new Error(`โหลดคอมโพเนนต์ ${tab} ไม่สำเร็จ (HTTP ${response.status})`);
      document.getElementById(panelId).innerHTML = await response.text();
    }));
  }

  function getDateValue(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function initializeDate() {
    const date = new Date();
    document.getElementById("selectedDate").value = getDateValue(date);
  }

  async function loadOrders() {
    const date = document.getElementById("selectedDate").value;
    const container = document.getElementById("customerCardsContainer");
    if (container) container.innerHTML = '<div class="text-center py-10 text-gray-400">กำลังโหลดข้อมูล...</div>';
    try {
      const data = await requestJson(`${config.APPS_SCRIPT_URL}?action=getAdminOrders&date=${encodeURIComponent(date)}`);
      if (data.success !== true) throw new Error(data.error || "Apps Script ปฏิเสธการโหลดออเดอร์");
      if (!Array.isArray(data.orders)) throw new Error("รูปแบบข้อมูลออเดอร์ไม่ถูกต้อง");
      state.currentOrders = data.orders;
      state.currentOrders.forEach(order => (Array.isArray(order.items) ? order.items : []).forEach(item => {
        const key = `${order.customerName}_${item.name}`;
        if (state.customPrices[key] === undefined && item.unitPrice !== undefined && item.unitPrice !== null) {
          state.customPrices[key] = Number(item.unitPrice) || 0;
        }
      }));
      localStorage.setItem("market_custom_prices", JSON.stringify(state.customPrices));
      renderDashboard();
    } catch (error) {
      state.currentOrders = [];
      renderDashboard();
      const message = `<div class="p-4 rounded-xl bg-red-50 text-red-700">โหลดออเดอร์ไม่สำเร็จ: ${escapeHtml(error.message)}</div>`;
      document.getElementById("summaryList").innerHTML = message;
      if (container) container.innerHTML = message;
      console.error("โหลดออเดอร์ไม่สำเร็จ", error);
    }
  }

  function renderDashboard() {
    renderMarketTab();
    renderPackingTab();
    renderFinanceSummary();
  }

  function renderMarketTab() {
    const list = document.getElementById("summaryList");
    if (!list) return;
    if (!state.currentOrders.length) {
      list.innerHTML = '<div class="text-center py-10 text-gray-400 bg-white rounded-2xl border p-6">ไม่มีรายการสั่งซื้อสำหรับวันที่เลือก</div>';
      document.getElementById("addonSection").classList.add("hidden");
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
    addonSection.classList.toggle("hidden", addons.length === 0);
    document.getElementById("addonList").innerHTML = addons.map(addon => `
      <div class="bg-white/90 p-2.5 rounded-xl border border-amber-200 text-xs text-amber-950">
        <strong class="text-amber-900">🏪 ${escapeHtml(addon.shop)}:</strong>
        <div class="text-sm font-semibold">${escapeHtml(addon.note)}</div>
      </div>`).join("");

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

  function orderItemPrice(order, item) {
    const key = `${order.customerName}_${item.name}`;
    const savedPrice = state.customPrices[key];
    if (savedPrice !== undefined && savedPrice !== null && savedPrice !== "") return Number(savedPrice) || 0;
    if (item.unitPrice !== undefined && item.unitPrice !== null && item.unitPrice !== "") {
      state.customPrices[key] = Number(item.unitPrice) || 0;
      return state.customPrices[key];
    }
    return "";
  }

  function orderTotal(order) {
    return order.items.reduce((total, item) => {
      const price = orderItemPrice(order, item);
      return total + (Number(item.qty) || 0) * (Number(price) || 0);
    }, 0);
  }

  function formatMoney(amount) {
    return (Number(amount) || 0).toLocaleString("th-TH", { maximumFractionDigits: 2 });
  }

  function renderFinanceSummary() {
    const shops = new Map();
    state.currentOrders.forEach(order => {
      const shop = shops.get(order.customerName) || { name: order.customerName, orders: [] };
      shop.orders.push(order);
      shops.set(order.customerName, shop);
    });
    const summaries = [...shops.values()].map(shop => ({
      ...shop,
      paid: shop.orders.every(order => order.paymentStatus === "ชำระแล้ว"),
      amount: shop.orders.reduce((sum, order) => sum + orderTotal(order), 0)
    }));
    const paidShops = summaries.filter(shop => shop.paid);
    const unpaidShops = summaries.filter(shop => !shop.paid);
    const totalFor = list => list.reduce((sum, shop) => sum + shop.amount, 0);
    document.getElementById("financeShopCount").textContent = summaries.length;
    document.getElementById("financePaidCount").textContent = paidShops.length;
    document.getElementById("financePaidAmount").textContent = formatMoney(totalFor(paidShops));
    document.getElementById("financeUnpaidCount").textContent = unpaidShops.length;
    document.getElementById("financeUnpaidAmount").textContent = formatMoney(totalFor(unpaidShops));
    document.getElementById("financeUnpaidShops").textContent =
      `ร้านค้างชำระ: ${unpaidShops.length ? unpaidShops.map(shop => shop.name).join(", ") : "-"}`;
  }

  function renderPackingTab() {
    const container = document.getElementById("customerCardsContainer");
    if (!container) return;
    document.getElementById("statTotalShops").textContent = state.currentOrders.length;
    const orders = state.currentOrders.map(order => {
      const items = Array.isArray(order.items) ? order.items : [];
      const checked = items.reduce((count, item, index) =>
        count + (state.packedItems[`${order.orderId}_${index}`] ? 1 : 0), 0);
      return { ...order, items, checked, remaining: items.length - checked, done: items.length > 0 && checked === items.length };
    }).sort((a, b) => Number(a.done) - Number(b.done));
    const completed = orders.filter(order => order.done).length;
    document.getElementById("statCompletedShops").textContent = completed;

    if (!orders.length) {
      container.innerHTML = '<div class="text-center py-10 text-gray-400 bg-white rounded-2xl border p-6">ไม่มีรายการสั่งซื้อสำหรับวันที่เลือก</div>';
      return;
    }
    container.innerHTML = orders.map(order => {
      const status = order.items.length === 0 ? "ไม่มีรายการ" :
        order.done ? `✓ ครบแล้ว (${order.checked}/${order.items.length})` :
          order.checked ? `⚠️ ค้าง ${order.remaining} รายการ (${order.checked}/${order.items.length})` :
            `⏳ ยังไม่ได้ของ (${order.items.length})`;
      const shopOrders = state.currentOrders.filter(item => item.customerName === order.customerName);
      const shopPaid = shopOrders.every(item => item.paymentStatus === "ชำระแล้ว");
      return `<article data-order-card="${escapeHtml(order.orderId)}" class="rounded-2xl border-2 p-4 shadow-sm space-y-3 ${order.done ? "bg-gray-50 opacity-80" : order.checked ? "bg-amber-50/40 border-amber-400" : "bg-white border-gray-200"}">
        <div class="flex justify-between items-start border-b pb-2.5 gap-2">
          <div><h3 class="font-extrabold text-lg">🏪 ${escapeHtml(order.customerName)}</h3>
            <div class="text-[11px] text-emerald-800">🕐 สั่ง: ${escapeHtml(formatOrderTime(order.timestamp))} · รหัส: ${escapeHtml(order.orderId)}</div></div>
          <span class="shrink-0 text-xs font-bold">${status}</span>
        </div>
        <div class="space-y-2">${order.items.map((item, index) => {
          const key = `${order.orderId}_${index}`;
          const checked = !!state.packedItems[key];
          const edited = item.originalQty !== undefined && Number(item.originalQty) !== Number(item.qty);
          const price = orderItemPrice(order, item);
          const lineTotal = (Number(item.qty) || 0) * (Number(price) || 0);
          return `<div data-price-row class="p-3 rounded-xl border flex items-center justify-between gap-2 ${checked ? "bg-emerald-100/60 border-emerald-400" : "bg-gray-50 border-gray-200"}">
            <label class="flex items-center gap-3 flex-1 cursor-pointer">
              <input type="checkbox" data-action="toggle-packed" data-order="${escapeHtml(order.orderId)}" data-index="${index}" ${checked ? "checked" : ""} class="w-5 h-5 rounded text-emerald-600">
              <span class="min-w-0"><strong class="text-base ${checked ? "line-through text-gray-500" : ""}">${escapeHtml(item.name)}</strong>
                ${edited ? `<small class="block text-[11px] text-amber-700 font-semibold">แม่ปรับยอด · เดิมสั่ง <span class="line-through">${escapeHtml(item.originalQty)}</span> → ได้ ${escapeHtml(item.qty)} ${escapeHtml(item.unit)}</small>` : ""}</span>
            </label>
            <div class="text-right shrink-0">
              <span class="font-extrabold whitespace-nowrap">${escapeHtml(item.qty)} ${escapeHtml(item.unit)}</span>
              <label class="flex items-center justify-end gap-1 mt-1 text-[10px] text-gray-500">
                <span>บาท/${escapeHtml(item.unit)}</span>
                <input data-action="unit-price" data-order="${escapeHtml(order.orderId)}" data-index="${index}" type="number" min="0" step="0.01" inputmode="decimal" value="${price === "" ? "" : escapeHtml(price)}" placeholder="ราคา" aria-label="ราคาต่อหน่วย ${escapeHtml(item.name)}" class="w-20 p-1 border rounded text-right text-xs">
              </label>
              <small class="block text-[10px] text-gray-600"><span data-line-total>${formatMoney(lineTotal)}</span> บาท</small>
            </div>
            <button data-action="edit-qty" data-order="${escapeHtml(order.orderId)}" data-index="${index}" class="p-1.5 bg-white border rounded-lg" title="ปรับจำนวน">✏️</button>
          </div>`;
        }).join("")}</div>
        <div class="flex justify-between items-center bg-slate-50 border rounded-xl p-3">
          <strong>ยอดรวมร้าน</strong><strong data-order-total class="text-lg text-emerald-800">${formatMoney(orderTotal(order))} บาท</strong>
        </div>
        <button data-action="toggle-payment" data-order="${escapeHtml(order.orderId)}" class="w-full py-2.5 rounded-xl font-bold text-sm ${shopPaid ? "bg-emerald-600 text-white" : "bg-orange-100 text-orange-800 border border-orange-300"}">
          ${shopPaid ? "✓ ร้านนี้ชำระครบแล้ว · แตะเพื่อเปลี่ยนเป็นค้างชำระ" : "◷ ร้านนี้ค้างชำระ · แตะเมื่อรับเงินแล้ว"}
        </button>
        ${order.addOnNote ? `<div class="p-2.5 bg-amber-50 rounded-xl border border-amber-200 text-xs"><strong>📝 สั่งพิเศษ:</strong> ${escapeHtml(order.addOnNote)}</div>` : ""}
      </article>`;
    }).join("");
  }

  function setActiveTab(tab) {
    state.activeTab = tab;
    Object.entries(panelByTab).forEach(([key, panelId]) => {
      document.getElementById(panelId).classList.toggle("hidden", key !== tab);
    });
    document.querySelectorAll(".tab-button").forEach(button => {
      const active = button.dataset.tab === tab;
      button.className = `tab-button py-2.5 rounded-xl ${active ? "bg-white text-emerald-800 shadow" : "text-gray-500"}`;
    });
  }

  async function loadShops() {
    const list = document.getElementById("shopsListContainer");
    list.innerHTML = '<div class="text-center py-8 text-gray-400">กำลังโหลดรายชื่อร้านค้า...</div>';
    try {
      const data = await requestJson(`${config.APPS_SCRIPT_URL}?action=getInitialData`);
      if (data.success !== true) throw new Error(data.error || "Apps Script ปฏิเสธการโหลดร้านค้า");
      if (!Array.isArray(data.customers)) throw new Error("รูปแบบข้อมูลร้านค้าไม่ถูกต้อง");
      state.allShops = data.customers;
      renderShops();
    } catch (error) {
      list.innerHTML = `<div class="p-4 rounded-xl bg-red-50 text-red-700">โหลดรายชื่อร้านไม่สำเร็จ: ${escapeHtml(error.message)}</div>`;
      console.error("โหลดรายชื่อร้านไม่สำเร็จ", error);
    }
  }

  function shopLink(id) {
    const url = new URL("index.html", window.location.href);
    url.search = `?id=${encodeURIComponent(id)}`;
    return url.href;
  }

  function renderShops() {
    const container = document.getElementById("shopsListContainer");
    if (!container) return;
    const query = document.getElementById("searchShopInput").value.trim().toLowerCase();
    const filtered = state.allShops.filter(shop =>
      `${shop.name} ${shop.id} ${shop.contact || ""}`.toLowerCase().includes(query));
    if (!filtered.length) {
      container.innerHTML = '<div class="text-center py-10 text-gray-400 bg-white rounded-2xl border p-6">ไม่พบรายชื่อร้านค้า</div>';
      return;
    }
    container.innerHTML = filtered.map((shop, index) => `<article class="bg-white p-3.5 rounded-2xl border shadow-sm flex items-center justify-between gap-2">
      <div class="flex items-center gap-3 min-w-0"><span class="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold">${index + 1}</span>
        <div class="min-w-0"><strong class="block truncate">${escapeHtml(shop.name)}</strong>
          <small class="text-gray-500 font-mono">${escapeHtml(shop.id)}</small> ${shop.contact ? `<small class="text-gray-500"> · 📞 ${escapeHtml(shop.contact)}</small>` : ""}
        </div></div>
      <div class="flex items-center gap-1 shrink-0">
        <button data-action="copy-shop-link" data-shop-id="${escapeHtml(shop.id)}" data-shop-name="${escapeHtml(shop.name)}" class="bg-emerald-600 text-white px-2.5 py-2 rounded-xl text-xs font-bold">📋 LINE</button>
        <button data-action="edit-shop" data-shop-id="${escapeHtml(shop.id)}" class="p-2 bg-gray-100 rounded-xl">✏️</button>
        <button data-action="delete-shop" data-shop-id="${escapeHtml(shop.id)}" class="p-2 bg-red-50 text-red-600 rounded-xl">🗑️</button>
      </div></article>`).join("");
  }

  function generateShopId() {
    const bytes = new Uint8Array(5);
    crypto.getRandomValues(bytes);
    return `s_${Array.from(bytes, byte => (byte % 36).toString(36)).join("")}`;
  }

  async function createShop() {
    const nameInput = document.getElementById("newShopName");
    const phoneInput = document.getElementById("newShopPhone");
    const name = nameInput.value.trim();
    if (!name) return alert("กรุณากรอกชื่อร้านค้า");
    const contact = phoneInput.value.trim();
    if (!window.confirm(`ยืนยันเพิ่มร้านค้า "${name}"${contact ? ` เบอร์ ${contact}` : ""} และสร้างลิงก์สำหรับร้านนี้หรือไม่?`)) return;
    const button = document.getElementById("createShopButton");
    button.disabled = true;
    try {
      let id = generateShopId();
      while (state.allShops.some(shop => String(shop.id) === id)) id = generateShopId();
      await postAction({ action: "registerShop", shopId: id, shopName: name, contact });
      state.allShops.push({ id, name, contact });
      renderShops();
      nameInput.value = "";
      phoneInput.value = "";
      const link = shopLink(id);
      try {
        await navigator.clipboard.writeText(link);
        const status = document.getElementById("shopCopyStatus");
        status.textContent = `บันทึกร้านและคัดลอกลิงก์แล้ว: ${link}`;
        status.classList.remove("hidden");
      } catch {
        window.prompt("ร้านค้าถูกบันทึกแล้ว กรุณาคัดลอกลิงก์นี้ส่งทาง LINE:", link);
      }
    } catch (error) {
      alert(`ลงทะเบียนร้านไม่สำเร็จ: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  }

  function openShopEditor(id) {
    const shop = state.allShops.find(item => String(item.id) === id);
    if (!shop) return;
    document.getElementById("editShopId").value = shop.id;
    document.getElementById("editShopName").value = shop.name;
    document.getElementById("editShopPhone").value = shop.contact || "";
    const modal = document.getElementById("editShopModal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }

  function closeModal(id) {
    const modal = document.getElementById(id);
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }

  async function saveShop() {
    const id = document.getElementById("editShopId").value;
    const name = document.getElementById("editShopName").value.trim();
    const contact = document.getElementById("editShopPhone").value.trim();
    if (!name) return alert("กรุณากรอกชื่อร้านค้า");
    const currentShop = state.allShops.find(item => String(item.id) === id);
    if (!window.confirm(
      `ยืนยันแก้ไขข้อมูลร้านค้า?\n\nชื่อเดิม: ${currentShop ? currentShop.name : ""}\nชื่อใหม่: ${name}\nเบอร์โทรใหม่: ${contact || "ไม่ระบุ"}`
    )) return;
    const button = document.getElementById("saveShopButton");
    button.disabled = true;
    try {
      await postAction({ action: "updateShop", shopId: id, shopName: name, contact });
      const shop = state.allShops.find(item => String(item.id) === id);
      if (shop) Object.assign(shop, { name, contact });
      renderShops();
      closeModal("editShopModal");
    } catch (error) {
      alert(`แก้ไขร้านไม่สำเร็จ: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  }

  async function deleteShop(id) {
    const shop = state.allShops.find(item => String(item.id) === id);
    if (!shop || !confirm(`ยืนยันลบร้าน "${shop.name}"? ลูกค้าจะใช้ลิงก์เดิมสั่งไม่ได้`)) return;
    try {
      await postAction({ action: "deleteShop", shopId: id });
      state.allShops = state.allShops.filter(item => String(item.id) !== id);
      renderShops();
    } catch (error) {
      alert(`ลบร้านไม่สำเร็จ: ${error.message}`);
    }
  }

  function openQtyEditor(orderId, itemIndex) {
    const order = state.currentOrders.find(item => String(item.orderId) === orderId);
    const item = order && order.items && order.items[itemIndex];
    if (!item) return;
    state.editingContext = { orderId, itemIndex };
    document.getElementById("editVegName").textContent = `ปรับจำนวน: ${item.name}`;
    document.getElementById("editOriginalInfo").textContent =
      `ลูกค้าสั่ง: ${item.originalQty !== undefined ? item.originalQty : item.qty} ${item.unit}`;
    document.getElementById("editUnitLabel").textContent = item.unit;
    document.getElementById("newQtyInput").value = item.qty;
    const modal = document.getElementById("editQtyModal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }

  async function saveEditedQty() {
    if (!state.editingContext) return;
    const { orderId, itemIndex } = state.editingContext;
    const order = state.currentOrders.find(item => String(item.orderId) === orderId);
    const item = order && order.items && order.items[itemIndex];
    const qty = Number(document.getElementById("newQtyInput").value);
    if (!item || !Number.isFinite(qty) || qty < 0) return alert("กรุณาระบุจำนวนตั้งแต่ 0 ขึ้นไป");
    if (!window.confirm(`ยืนยันแก้ไขจำนวน "${item.name}" ของร้าน ${order.customerName}?\n\nจำนวนเดิม: ${item.qty} ${item.unit}\nจำนวนใหม่: ${qty} ${item.unit}`)) return;
    const originalQty = item.originalQty !== undefined ? item.originalQty : item.qty;
    const previousQty = item.qty;
    const hadOriginalQty = item.originalQty !== undefined;
    item.originalQty = originalQty;
    item.qty = qty;
    const button = document.getElementById("saveEditQtyButton");
    button.disabled = true;
    try {
      await postAction({ action: "updateOrderItems", orderId, items: order.items });
      await saveOrderPricing(orderId);
      closeModal("editQtyModal");
      state.editingContext = null;
      renderDashboard();
    } catch (error) {
      item.qty = previousQty;
      if (!hadOriginalQty) delete item.originalQty;
      alert(`บันทึกยอดแก้ไขไม่สำเร็จ: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  }

  async function saveOrderPricing(orderId) {
    const order = state.currentOrders.find(item => String(item.orderId) === orderId);
    if (!order) return;
    try {
      const matchingOrders = state.currentOrders.filter(item => item.customerName === order.customerName);
      await Promise.all(matchingOrders.map(matchingOrder => postAction({
        action: "updateOrderPricing",
        orderId: matchingOrder.orderId,
        items: matchingOrder.items.map(item => ({
          name: item.name,
          unit: item.unit,
          qty: Number(item.qty) || 0,
          unitPrice: Number(state.customPrices[`${matchingOrder.customerName}_${item.name}`]) || 0
        }))
      })));
    } catch (error) {
      alert(`บันทึกราคาไม่สำเร็จ: ${error.message}`);
    }
  }

  async function togglePaymentStatus(orderId) {
    const order = state.currentOrders.find(item => String(item.orderId) === orderId);
    if (!order) return;
    const matchingOrders = state.currentOrders.filter(item => item.customerName === order.customerName);
    const previousStatuses = matchingOrders.map(item => item.paymentStatus || "ค้างชำระ");
    const paymentStatus = matchingOrders.every(item => item.paymentStatus === "ชำระแล้ว") ? "ค้างชำระ" : "ชำระแล้ว";
    const amount = matchingOrders.reduce((sum, item) => sum + orderTotal(item), 0);
    if (!window.confirm(
      `ยืนยันเปลี่ยนสถานะการชำระเงินของร้าน "${order.customerName}" เป็น "${paymentStatus}"?\n\nยอดรวม ${formatMoney(amount)} บาท`
    )) return;
    matchingOrders.forEach(item => { item.paymentStatus = paymentStatus; });
    renderPackingTab();
    renderFinanceSummary();
    try {
      await Promise.all(matchingOrders.map(item =>
        postAction({ action: "updatePaymentStatus", orderId: item.orderId, paymentStatus })));
    } catch (error) {
      matchingOrders.forEach((item, index) => { item.paymentStatus = previousStatuses[index]; });
      await loadOrders();
      alert(`อัปเดตสถานะชำระเงินไม่สำเร็จ: ${error.message}`);
    }
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
          if (!dataUrl.startsWith("data:image/webp;")) return reject(new Error("แปลงรูปเป็น WebP ไม่สำเร็จ"));
          resolve(dataUrl.split(",")[1]);
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function saveNewItem() {
    const name = document.getElementById("newItemName").value.trim();
    if (!name) return alert("กรุณากรอกชื่อสินค้า");
    const unit = document.getElementById("newItemUnit").value;
    if (!window.confirm(`ยืนยันเพิ่มสินค้า "${name}" หน่วย ${unit}${state.selectedImageBase64 ? " พร้อมรูปภาพ" : " โดยไม่มีรูปภาพ"} หรือไม่?`)) return;
    const button = document.getElementById("saveItemButton");
    const status = document.getElementById("itemStatus");
    button.disabled = true;
    status.classList.add("hidden");
    try {
      const result = await postAction({
        action: "addNewItem",
        name,
        unit,
        base64Image: state.selectedImageBase64,
        driveFolderId: config.DRIVE_FOLDER_ID
      });
      if (result.success !== true) throw new Error(result.error || "Apps Script ไม่ยืนยันการบันทึกสินค้า");
      status.textContent = `เพิ่มสินค้า "${name}" สำเร็จ`;
      status.className = "text-sm font-semibold text-emerald-700";
      status.classList.remove("hidden");
      document.getElementById("newItemName").value = "";
      document.getElementById("itemImageInput").value = "";
      document.getElementById("itemImagePreview").classList.add("hidden");
      document.getElementById("itemImagePrompt").classList.remove("hidden");
      state.selectedImageBase64 = "";
    } catch (error) {
      status.textContent = `บันทึกสินค้าไม่สำเร็จ: ${error.message}`;
      status.className = "text-sm font-semibold text-red-700";
      status.classList.remove("hidden");
    } finally {
      button.disabled = false;
    }
  }

  async function handleClick(event) {
    const tabButton = event.target.closest("[data-tab]");
    if (tabButton) {
      const selectedTab = tabButton.dataset.tab;
      setActiveTab(selectedTab);
      if (selectedTab === "shops") renderShops();
      return;
    }
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
      case "edit-qty": openQtyEditor(control.dataset.order, Number(control.dataset.index)); break;
      case "close-edit-qty": closeModal("editQtyModal"); state.editingContext = null; break;
      case "save-edit-qty": await saveEditedQty(); break;
      case "toggle-payment": await togglePaymentStatus(control.dataset.order); break;
      case "copy-shop-link": {
        const link = shopLink(control.dataset.shopId);
        try { await navigator.clipboard.writeText(link); alert(`คัดลอกลิงก์ร้าน ${control.dataset.shopName} แล้ว`); }
        catch { window.prompt("คัดลอกลิงก์ส่งทาง LINE:", link); }
        break;
      }
      case "create-shop": await createShop(); break;
      case "edit-shop": openShopEditor(control.dataset.shopId); break;
      case "close-edit-shop": closeModal("editShopModal"); break;
      case "save-edit-shop": await saveShop(); break;
      case "delete-shop": await deleteShop(control.dataset.shopId); break;
      case "save-item": await saveNewItem(); break;
    }
  }

  function initializeEvents() {
    document.getElementById("adminApp").addEventListener("click", handleClick);
    document.getElementById("editQtyModal").addEventListener("click", handleClick);
    document.getElementById("refreshButton").addEventListener("click", () => {
      loadOrders();
      if (state.activeTab === "shops") loadShops();
    });
    document.getElementById("todayButton").addEventListener("click", () => {
      initializeDate();
      loadOrders();
    });
    document.getElementById("selectedDate").addEventListener("change", loadOrders);
    document.getElementById("adminApp").addEventListener("input", event => {
      if (event.target.id === "searchShopInput") renderShops();
      if (event.target.matches('[data-action="unit-price"]')) {
        const order = state.currentOrders.find(item => String(item.orderId) === event.target.dataset.order);
        if (!order) return;
        const item = order.items[Number(event.target.dataset.index)];
        if (!item) return;
        state.customPrices[`${order.customerName}_${item.name}`] =
          event.target.value === "" ? "" : Number(event.target.value);
        localStorage.setItem("market_custom_prices", JSON.stringify(state.customPrices));
        const card = event.target.closest("[data-order-card]");
        const priceRow = event.target.closest("[data-price-row]");
        const lineTotal = (Number(item.qty) || 0) * (Number(event.target.value) || 0);
        priceRow.querySelector("[data-line-total]").textContent = formatMoney(lineTotal);
        card.querySelector("[data-order-total]").textContent = `${formatMoney(orderTotal(order))} บาท`;
        renderFinanceSummary();
      }
    });
    document.getElementById("adminApp").addEventListener("focusin", event => {
      if (event.target.matches('[data-action="unit-price"]')) {
        event.target.dataset.confirmOriginal = event.target.value;
      }
    });
    document.getElementById("adminApp").addEventListener("change", async event => {
      if (event.target.matches('[data-action="unit-price"]')) {
        const input = event.target;
        const order = state.currentOrders.find(item => String(item.orderId) === input.dataset.order);
        const item = order && order.items[Number(input.dataset.index)];
        const previousValue = input.dataset.confirmOriginal ?? "";
        if (!item) return;
        if (input.value === previousValue) return;
        if (!window.confirm(
          `ยืนยันแก้ไขราคาต่อหน่วยของ "${item.name}" ร้าน ${order.customerName}?\n\nราคาเดิม: ${previousValue || "ยังไม่ระบุ"} บาท/${item.unit}\nราคาใหม่: ${input.value || "0"} บาท/${item.unit}`
        )) {
          input.value = previousValue;
          const priceKey = `${order.customerName}_${item.name}`;
          if (previousValue === "") delete state.customPrices[priceKey];
          else state.customPrices[priceKey] = Number(previousValue);
          localStorage.setItem("market_custom_prices", JSON.stringify(state.customPrices));
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return;
        }
        input.dataset.confirmOriginal = input.value;
        await saveOrderPricing(input.dataset.order);
        return;
      }
      if (event.target.id === "itemImageInput" && event.target.files[0]) {
        const status = document.getElementById("itemStatus");
        try {
          state.selectedImageBase64 = await processImageToWebP(event.target.files[0]);
          const preview = document.getElementById("itemImagePreview");
          preview.src = `data:image/webp;base64,${state.selectedImageBase64}`;
          preview.classList.remove("hidden");
          document.getElementById("itemImagePrompt").classList.add("hidden");
        } catch (error) {
          status.textContent = error.message;
          status.className = "text-sm font-semibold text-red-700";
          status.classList.remove("hidden");
          event.target.value = "";
        }
      }
    });
  }

  async function initialize() {
    try {
      initializeDate();
      await loadComponents();
      initializeEvents();
      setActiveTab("market");
      await Promise.all([loadOrders(), loadShops()]);
    } catch (error) {
      document.getElementById("adminApp").innerHTML =
        `<div class="p-4 rounded-xl bg-red-50 text-red-700">เริ่มต้นแดชบอร์ดไม่สำเร็จ: ${escapeHtml(error.message)}</div>`;
      console.error("เริ่มต้นแดชบอร์ดไม่สำเร็จ", error);
    }
  }

  initialize();
})();
