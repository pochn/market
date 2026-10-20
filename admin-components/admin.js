(function () {
  const config = window.MarketConfig;
  const state = window.MarketState;
  let shopHistoryRequestId = 0;
  let unpaidShopsThisRound = [];
  if (!state.customPrices || typeof state.customPrices !== "object" || Array.isArray(state.customPrices)) {
    state.customPrices = {};
  }
  if (!(state.unlockEditingOrders instanceof Set)) {
    state.unlockEditingOrders = new Set();
  }
  if (!["pending", "paid", "all"].includes(state.packingFilter)) {
    state.packingFilter = "pending";
  }
  if (typeof state.showCancelledOrders !== "boolean") {
    state.showCancelledOrders = false;
  }
  if (!(state.sharedLineOrders instanceof Set)) {
    try {
      const sharedOrders = JSON.parse(localStorage.getItem("market_shared_line_orders") || "[]");
      state.sharedLineOrders = new Set(Array.isArray(sharedOrders) ? sharedOrders.map(String) : []);
    } catch (error) {
      console.warn("สถานะการแชร์ LINE ใน localStorage ไม่ถูกต้อง", error);
      state.sharedLineOrders = new Set();
    }
  }

  const adminFontSizes = { small: "100%", medium: "115%", large: "130%" };

  function setAdminFontSize(size) {
    if (!Object.prototype.hasOwnProperty.call(adminFontSizes, size)) return;
    document.documentElement.style.fontSize = adminFontSizes[size];
    document.querySelectorAll(".admin-font-size-button").forEach(button => {
      const isActive = button.dataset.fontSize === size;
      button.setAttribute("aria-pressed", String(isActive));
      button.classList.toggle("bg-white", isActive);
      button.classList.toggle("text-emerald-900", isActive);
      button.classList.toggle("shadow", isActive);
      button.classList.toggle("text-emerald-100", !isActive && button.dataset.fontSize !== "large");
      button.classList.toggle("text-amber-300", !isActive && button.dataset.fontSize === "large");
    });
    try {
      localStorage.setItem("admin_font_size", size);
    } catch (error) {
      console.warn("บันทึกขนาดตัวอักษรแอดมินไม่สำเร็จ", error);
    }
  }

  function initializeAdminFontSize() {
    let size = "medium";
    try {
      const savedSize = localStorage.getItem("admin_font_size");
      if (Object.prototype.hasOwnProperty.call(adminFontSizes, savedSize)) size = savedSize;
    } catch (error) {
      console.warn("อ่านขนาดตัวอักษรแอดมินที่บันทึกไว้ไม่สำเร็จ", error);
    }
    setAdminFontSize(size);
  }

  const panelByTab = {
    market: "marketPanel",
    packing: "packingPanel",
    finance: "financePanel",
    itemsList: "itemsListPanel",
    items: "itemsPanel",
    shops: "shopsPanel",
    shopHistory: "shopHistoryPanel",
    settings: "settingsPanel"
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
    if (date.getHours() >= 11) date.setDate(date.getDate() + 1);
    document.getElementById("selectedDate").value = 
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function scheduleMarketDateCutoff() {
    const now = new Date();
    const nextCutoff = new Date(now);
    nextCutoff.setHours(11, 0, 0, 0);
    if (nextCutoff <= now) nextCutoff.setDate(nextCutoff.getDate() + 1);

    window.setTimeout(() => {
      const currentDate = new Date();
      const today = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, "0")}-${String(currentDate.getDate()).padStart(2, "0")}`;
      const selectedDate = document.getElementById("selectedDate");
      if (selectedDate?.value === today) {
        initializeDate();
        loadOrders();
      }
      scheduleMarketDateCutoff();
    }, nextCutoff.getTime() - now.getTime());
  }

  function getOrderTimestamp(order) {
    const timestamp = Date.parse(order.timestamp);
    if (Number.isFinite(timestamp)) return timestamp;

    const orderIdMatch = String(order.orderId || "").match(/(\d{8})-(\d{6})$/);
    if (!orderIdMatch) return 0;
    const [, date, time] = orderIdMatch;
    return Date.parse(
      `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`
    ) || 0;
  }

  // โหลดออเดอร์
  async function loadOrders() {
    const date = document.getElementById("selectedDate").value;
    const container = document.getElementById("customerCardsContainer");
    if (container) container.innerHTML = '<div class="text-center py-10 text-gray-400">กำลังโหลดข้อมูล...</div>';

    try {
      const data = await requestJson(`${config.APPS_SCRIPT_URL}?action=getAdminOrders&date=${encodeURIComponent(date)}`);
      state.currentOrders = (Array.isArray(data.orders) ? data.orders : [])
        .map((order, index) => ({ order, index }))
        .sort((a, b) => getOrderTimestamp(b.order) - getOrderTimestamp(a.order) || a.index - b.index)
        .map(entry => entry.order);
      state.currentOrders.forEach(order => {
        if (!hasInvoiceBeenSent(order)) return;
        (Array.isArray(order.items) ? order.items : []).forEach((item, index) => {
          const key = `${order.orderId}_${index}`;
          if (Number(item.qty) > 0 && item.unavailable !== true) state.packedItems[key] = true;
          else delete state.packedItems[key];
        });
      });
      try {
        localStorage.setItem("market_packed_items", JSON.stringify(state.packedItems));
      } catch (error) {
        console.warn("บันทึกสถานะรายการที่จัดแล้วไม่สำเร็จ", error);
      }
      renderDashboard();
      return true;
    } catch (error) {
      state.currentOrders = [];
      renderDashboard();
      console.error("โหลดออเดอร์ไม่สำเร็จ", error);
      return false;
    }
  }

  // โหลดข้อมูลผักและร้านค้าทั้งหมด
  async function loadInitialData() {
    try {
      const data = await requestJson(`${config.APPS_SCRIPT_URL}?action=getInitialData`);
      if (data.success) {
        state.vegetables = Array.isArray(data.vegetables) ? data.vegetables : [];
        state.allShops = Array.isArray(data.customers) ? data.customers : [];
        populateHistoryShopSelect();
        state.cutoffTime = /^\d{2}:\d{2}$/.test(data.cutoffTime || "") ? data.cutoffTime : "00:00";
        const cutoffInput = document.getElementById("cutoffTimeInput");
        if (cutoffInput) cutoffInput.value = state.cutoffTime;
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
      }, Number(order.addOnPrice) || 0);

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

  function updatePackingFinanceBar(orders) {
    const unpaidByShop = new Map();
    orders.forEach(order => {
      const amount = Number(order.totalAmount) || 0;
      if (!hasInvoiceBeenSent(order) || order.paymentStatus === "ชำระแล้ว" ||
          String(order.status || "").trim() === "ยกเลิกแล้ว" || amount <= 0) return;

      const shopName = String(order.customerName || "ไม่ระบุชื่อร้าน");
      if (!unpaidByShop.has(shopName)) {
        unpaidByShop.set(shopName, {
          shopName,
          totalAmount: 0,
          bills: []
        });
      }

      const shopData = unpaidByShop.get(shopName);
      shopData.totalAmount += amount;
      shopData.bills.push({
        orderId: order.orderId,
        orderDate: order.orderDate,
        amount
      });
    });
    unpaidShopsThisRound = [...unpaidByShop.values()]
      .sort((a, b) => a.shopName.localeCompare(b.shopName, "th"));

    const total = unpaidShopsThisRound.reduce((sum, shop) => sum + shop.totalAmount, 0);
    const headerCount = document.getElementById("headerUnpaidCount");
    const headerTotal = document.getElementById("headerUnpaidTotal");
    if (headerCount) headerCount.textContent = String(unpaidShopsThisRound.length);
    if (headerTotal) headerTotal.textContent = total.toLocaleString("th-TH", { maximumFractionDigits: 2 });
  }

  async function showUnpaidShopsModal() {
    if (!unpaidShopsThisRound.length) return;
    const rows = unpaidShopsThisRound.map(shop => {
      const billsHtml = shop.bills.map(bill => `
        <div class="flex flex-wrap sm:flex-nowrap justify-between items-center gap-2 text-xs py-1.5 px-2 bg-white rounded-lg border border-amber-200 my-1 shadow-sm">
          <div class="min-w-0 flex-1">
            <div class="font-bold text-gray-800">รอบวันที่ ${escapeHtml(bill.orderDate)}</div>
            <div class="text-[10px] text-gray-400 font-mono truncate">${escapeHtml(bill.orderId)}</div>
            <div class="font-black text-red-600 text-sm mt-0.5">${bill.amount.toLocaleString("th-TH", { maximumFractionDigits: 2 })} ฿</div>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button type="button" data-action="quick-share-line" data-order-id="${escapeHtml(bill.orderId)}"
              class="px-2 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-300 rounded-lg font-bold text-[11px] flex items-center gap-1 shadow-sm">
              <span>📲 LINE</span>
            </button>
            <button type="button" data-action="quick-pay-order" data-order-id="${escapeHtml(bill.orderId)}" data-shop-name="${escapeHtml(shop.shopName)}"
              class="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white rounded-lg font-bold text-[11px] flex items-center gap-1 shadow-sm">
              <span>🟢 ชำระแล้ว</span>
            </button>
          </div>
        </div>
      `).join("");

      return `
        <div class="py-2.5 border-b border-gray-100 last:border-b-0 space-y-1.5">
          <div class="flex justify-between items-center text-sm px-1">
            <span class="font-extrabold text-gray-900">🏪 ${escapeHtml(shop.shopName)} <span class="text-xs font-normal text-gray-500">(${shop.bills.length} บิล)</span></span>
            <span class="font-black text-red-600 text-base">รวม ${shop.totalAmount.toLocaleString("th-TH", { maximumFractionDigits: 2 })} ฿</span>
          </div>
          <div class="space-y-1 bg-amber-50/60 p-2 rounded-xl border border-amber-200">
            ${billsHtml}
          </div>
        </div>
      `;
    }).join("");
    const total = unpaidShopsThisRound.reduce((sum, shop) => sum + shop.totalAmount, 0);

    await Swal.fire({
      title: "⚠️ รายละเอียดร้านค้างชำระ",
      html: `
        <div class="text-left max-h-80 overflow-y-auto space-y-2 mt-2 pr-1">
          ${rows}
        </div>
        <div class="flex justify-between items-center pt-3 mt-3 border-t text-base font-extrabold">
          <span class="text-gray-700">ยอดค้างรวมทั้งหมด:</span>
          <span class="text-red-600 text-lg">${total.toLocaleString("th-TH", { maximumFractionDigits: 2 })} ฿</span>
        </div>
      `,
      confirmButtonText: "ปิด",
      confirmButtonColor: "#6b7280"
    });
  }

  function renderDashboard() {
    renderMarketTab();
    renderPackingTab();
  }

  function renderMarketTab() {
    const list = document.getElementById("summaryList");
    if (!list) return;
    const pendingOrders = state.currentOrders.filter(order =>
      String(order.status || "").trim() !== "ยกเลิกแล้ว" && !hasInvoiceBeenSent(order)
    );
    const addonSection = document.getElementById("addonSection");

    if (!pendingOrders.length) {
      const allOrders = state.currentOrders.filter(order =>
        String(order.status || "").trim() !== "ยกเลิกแล้ว"
      );
      const isAllCompleted = allOrders.length > 0 && allOrders.every(hasInvoiceBeenSent);

      list.innerHTML = `
        <div class="text-center py-10 bg-white rounded-2xl border p-6 space-y-2">
          <span class="text-3xl">${isAllCompleted ? "🎉" : "🛒"}</span>
          <h3 class="font-extrabold text-base ${isAllCompleted ? "text-emerald-700" : "text-gray-700"}">
            ${isAllCompleted ? "✓ จัดซื้อและส่งใบส่งของครบทุกร้านแล้วสำหรับรอบนี้" : "ไม่มีรายการที่ต้องซื้อสำหรับรอบนี้"}
          </h3>
          <p class="text-xs text-gray-400">
            ${isAllCompleted ? "ยอดซื้อตลาดสำหรับรอบนี้เสร็จสิ้นเรียบร้อยแล้ว" : "ยังไม่มีออเดอร์ใหม่เข้ามา"}
          </p>
        </div>
      `;
      if (addonSection) addonSection.classList.add("hidden");
      return;
    }

    const totals = new Map();
    const addons = [];
    pendingOrders.forEach(order => {
      if (order.addOnNote && String(order.addOnNote).trim()) {
        addons.push({ shop: order.customerName, note: order.addOnNote });
      }

      (Array.isArray(order.items) ? order.items : []).forEach(item => {
        const qty = Number(item.qty) || 0;
        if (qty <= 0 || item.unavailable === true) return;

        const key = JSON.stringify([item.name, item.unit]);
        const current = totals.get(key) || { key, name: item.name, unit: item.unit, qty: 0, shops: [] };
        current.qty += qty;
        current.shops.push(`${order.customerName} (${qty})`);
        totals.set(key, current);
      });
    });

    if (addonSection) {
      addonSection.classList.toggle("hidden", addons.length === 0);
      const addonList = document.getElementById("addonList");
      if (addonList) {
        addonList.innerHTML = addons.map(addon => `
          <div class="bg-white/90 p-2.5 rounded-xl border border-amber-200 text-xs text-amber-950">
            <strong class="text-amber-900">🏪 ${escapeHtml(addon.shop)}:</strong>
            <div class="text-sm font-semibold">${escapeHtml(addon.note)}</div>
          </div>`).join("");
      }
    }

    if (totals.size === 0) {
      list.innerHTML = '<div class="text-center py-8 text-gray-400 bg-white rounded-2xl border">ไม่มีรายการผักที่ต้องซื้อเพิ่ม</div>';
      return;
    }

    list.innerHTML = [...totals.values()].map(item => {
      const bought = state.boughtItems.has(item.key);
      return `
      <button data-action="toggle-bought" data-key="${escapeHtml(item.key)}"
        class="w-full text-left p-3.5 rounded-2xl border-2 flex items-center justify-between gap-3 shadow-sm transition ${bought ? "checked-box bg-gray-50 border-gray-200" : "bg-white border-gray-200 hover:border-emerald-300"}">
        <span class="flex items-center gap-3 min-w-0">
          <input type="checkbox" ${bought ? "checked" : ""} tabindex="-1" class="w-6 h-6 rounded text-emerald-600 pointer-events-none shrink-0">
          <span class="min-w-0">
            <strong class="block text-lg truncate ${bought ? "line-through text-gray-400" : "text-gray-900"}">${escapeHtml(item.name)}</strong>
            <small class="text-gray-500 block truncate">ร้านที่สั่ง: ${escapeHtml(item.shops.join(", "))}</small>
          </span>
        </span>
        <span class="text-right whitespace-nowrap shrink-0">
          <strong class="text-2xl text-emerald-700 ${bought ? "line-through text-gray-400" : ""}">${escapeHtml(item.qty)}</strong>
          <small class="block text-gray-600">${escapeHtml(item.unit)}</small>
        </span>
      </button>`;
    }).join("");
  }

  function formatOrderTime(timestamp) {
    if (!timestamp) return "ไม่ระบุเวลา";
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return String(timestamp);
    return `${date.getDate()} ${date.toLocaleDateString("th-TH", { month: "short" })} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")} น.`;
  }

  function priceStorageKey(item) {
    return JSON.stringify([item.name, item.unit]);
  }

  function getUnitPrice(item) {
    if (item.unitPrice !== undefined && item.unitPrice !== null && item.unitPrice !== "") {
      return String(item.unitPrice);
    }
    const savedPrice = state.customPrices[priceStorageKey(item)];
    return savedPrice === undefined ? "" : String(savedPrice);
  }

  function hasInvoiceBeenSent(order) {
    return Number(order.totalAmount) > 0 || Boolean(order.invoiceSentAt) || order.hasPricing ||
      (Array.isArray(order.items) && order.items.some(item =>
        item.unitPrice !== undefined && item.unitPrice !== null && item.unitPrice !== ""));
  }

  function calculateRenderedOrderTotal(card) {
    const orderId = card.dataset.orderCard;
    const order = state.currentOrders.find(item => String(item.orderId) === orderId);
    if (!order) return;

    let vegTotal = 0;
    const priceInputs = card.querySelectorAll("[data-unit-price]");
    priceInputs.forEach(input => {
      const idx = Number(input.dataset.index);
      const isPacked = state.packedItems[`${orderId}_${idx}`] === true;
      const item = order.items && order.items[idx];
      const unitPrice = input.value === "" ? 0 : Number(input.value);
      if (isPacked && item && Number.isFinite(unitPrice)) {
        vegTotal += (Number(item.qty) || 0) * unitPrice;
      }
    });

    const addOnInput = card.querySelector("[data-addon-price]");
    const addOnPrice = addOnInput && addOnInput.value !== ""
      ? Number(addOnInput.value) || 0
      : 0;
    const grandTotal = vegTotal + addOnPrice;
    const totalElement = card.querySelector("[data-order-total]");
    if (totalElement) {
      totalElement.textContent = grandTotal.toLocaleString("th-TH", { maximumFractionDigits: 2 });
    }
  }

  function getUnpickedItems(order) {
    return order.items.filter((item, index) =>
      state.packedItems[`${order.orderId}_${index}`] !== true);
  }

  async function confirmUnpickedItems(order) {
    const unpickedItems = getUnpickedItems(order);
    if (!unpickedItems.length) return true;

    const names = unpickedItems.map(item => escapeHtml(item.name)).join(", ");
    const result = await Swal.fire({
      icon: "warning",
      title: "มีรายการที่ไม่ได้จัดของ!",
      html: `พบ <b>${unpickedItems.length}</b> รายการที่ไม่ได้ติ๊กรับของ:<br><b class="text-amber-700">${names}</b><br><br>รายการเหล่านี้จะถูกตั้งยอดเป็น <b>0 บาท (ของหมด)</b> ในใบส่งของลูกค้า<br>ยืนยันที่จะส่งใบส่งของหรือไม่?`,
      showCancelButton: true,
      confirmButtonText: "ยืนยันส่งใบส่งของ",
      cancelButtonText: "กลับไปตรวจก่อน",
      confirmButtonColor: "#059669",
      cancelButtonColor: "#6b7280"
    });
    return result.isConfirmed;
  }

  function buildPricedInvoiceItems(order, card) {
    return order.items.map((item, index) => {
      const picked = state.packedItems[`${order.orderId}_${index}`] === true;
      const input = card.querySelector(`[data-unit-price][data-index="${index}"]`);
      const qty = picked ? Number(item.qty) || 0 : 0;
      return {
        ...item,
        qty,
        unitPrice: picked ? (input && input.value !== "" ? Number(input.value) : NaN) : 0,
        unavailable: !picked || qty === 0
      };
    });
  }

  function orderInvoiceText(order, card) {
    const isInvoiceSent = hasInvoiceBeenSent(order);
    let vegetableTotal = 0;
    const lines = (Array.isArray(order.items) ? order.items : []).map((item, index) => {
      const input = card && card.querySelector(`[data-unit-price][data-index="${index}"]`);
      const isPacked = isInvoiceSent
        ? Number(item.qty) > 0 && item.unavailable !== true
        : card
          ? state.packedItems[`${order.orderId}_${index}`] === true
          : Number(item.qty) > 0 && item.unavailable !== true;
      const qty = isInvoiceSent ? Number(item.qty) || 0 : isPacked ? Number(item.qty) || 0 : 0;
      const unitPrice = input && input.value !== ""
        ? Number(input.value) || 0
        : Number(item.unitPrice) || 0;
      if (!isPacked || qty === 0 || item.unavailable === true) {
        return `• ${item.name}: (ของหมด / ตัดยอด 0 บาท)`;
      }
      const lineTotal = qty * unitPrice;
      vegetableTotal += lineTotal;
      return `• ${item.name} ${qty} ${item.unit} × ${unitPrice.toLocaleString("th-TH")} = ${lineTotal.toLocaleString("th-TH")} บาท`;
    });
    const addOnPriceInput = card && card.querySelector("[data-addon-price]");
    const addOnPrice = addOnPriceInput
      ? Number(addOnPriceInput.value) || 0
      : Number(order.addOnPrice) || 0;
    const total = isInvoiceSent ? Number(order.totalAmount) || 0 : vegetableTotal + addOnPrice;
    const addOnLine = order.addOnNote && String(order.addOnNote).trim()
      ? `• สั่งพิเศษ: ${order.addOnNote}${addOnPrice > 0 ? ` = ${addOnPrice.toLocaleString("th-TH")} บาท` : ""}`
      : "";
    const noteLine = order.notes && String(order.notes).trim()
      ? `💬 ข้อความจากร้าน: ${String(order.notes).trim()}`
      : "";
    return [
      `🧾 ใบส่งของ - ${order.customerName}`,
      `รอบวันที่: ${order.orderDate}`,
      `เลขที่บิล: ${order.orderId}`,
      "--------------------------",
      ...lines,
      ...(addOnLine ? [addOnLine] : []),
      "--------------------------",
      `ยอดรวมสุทธิ: ${total.toLocaleString("th-TH", { maximumFractionDigits: 2 })} บาท`,
      `สถานะ: ${order.paymentStatus || "ค้างชำระ"}`,
      ...(noteLine ? ["--------------------------", noteLine] : [])
    ].join("\n");
  }

  function renderPackingTab() {
    const container = document.getElementById("customerCardsContainer");
    if (!container) return;

    const allActiveOrders = state.currentOrders.filter(order =>
      String(order.status || "").trim() !== "ยกเลิกแล้ว" && !order.adminCancelledAt
    ).map(order => {
      const items = Array.isArray(order.items) ? order.items : [];
      const invoiceSent = hasInvoiceBeenSent({ ...order, items });
      const checked = items.reduce((count, item, index) =>
        count + (invoiceSent
          ? Number(item.qty) > 0 && item.unavailable !== true ? 1 : 0
          : state.packedItems[`${order.orderId}_${index}`] === true ? 1 : 0), 0);
      return { ...order, items, checked, remaining: items.length - checked, done: items.length > 0 && checked === items.length };
    });
    const cancelledOrders = state.currentOrders.filter(order =>
      Boolean(order.adminCancelledAt)
    ).map(order => {
      const items = Array.isArray(order.items) ? order.items : [];
      const invoiceSent = hasInvoiceBeenSent({ ...order, items });
      const checked = items.reduce((count, item, index) =>
        count + (invoiceSent
          ? Number(item.qty) > 0 && item.unavailable !== true ? 1 : 0
          : state.packedItems[`${order.orderId}_${index}`] === true ? 1 : 0), 0);
      return { ...order, items, checked, remaining: items.length - checked, done: items.length > 0 && checked === items.length };
    });
    const visibleOrders = allActiveOrders.filter(order =>
      state.packingFilter === "all" ||
      (state.packingFilter === "paid" && order.paymentStatus === "ชำระแล้ว") ||
      (state.packingFilter === "pending" && order.paymentStatus !== "ชำระแล้ว")
    );

    const completed = allActiveOrders.filter(order =>
      !order.adminCancelledAt && order.done
    ).length;
    const statCompleted = document.getElementById("statCompletedShops");
    if (statCompleted) statCompleted.textContent = completed;

    updateFinanceStats(allActiveOrders);
    updatePackingFinanceBar([...allActiveOrders, ...cancelledOrders]);

    if (!allActiveOrders.length && !cancelledOrders.length) {
      container.innerHTML = '<div class="text-center py-10 text-gray-400 bg-white rounded-2xl border p-6">ไม่มีรายการสั่งซื้อสำหรับวันที่เลือก</div>';
      return;
    }

    const filterBar = `<div class="flex items-center justify-between gap-1 bg-gray-200/70 p-1 rounded-xl text-xs font-bold mb-2">
      <button data-action="filter-orders" data-filter="pending" class="flex-1 py-1.5 rounded-lg text-center transition ${state.packingFilter === "pending" ? "bg-white text-emerald-800 shadow" : "text-gray-500"}">⏳ รอดำเนินการ/ค้างจ่าย</button>
      <button data-action="filter-orders" data-filter="paid" class="flex-1 py-1.5 rounded-lg text-center transition ${state.packingFilter === "paid" ? "bg-white text-emerald-800 shadow" : "text-gray-500"}">✓ ชำระแล้ว</button>
      <button data-action="filter-orders" data-filter="all" class="flex-1 py-1.5 rounded-lg text-center transition ${state.packingFilter === "all" ? "bg-white text-emerald-800 shadow" : "text-gray-500"}">ทั้งหมด (${allActiveOrders.length})</button>
    </div>`;
    const renderOrderCard = order => {
      const isCancelledByAdmin = Boolean(order.adminCancelledAt);
      const status = isCancelledByAdmin ? "❌ ยกเลิกแล้ว" : order.items.length === 0 ? "ไม่มีรายการ" :
        order.done ? `✓ ครบแล้ว (${order.checked}/${order.items.length})` :
          order.checked ? `⚠️ ค้าง ${order.remaining} รายการ (${order.checked}/${order.items.length})` :
            `⏳ ยังไม่ได้ของ (${order.items.length})`;
      const isInvoiceSent = hasInvoiceBeenSent(order);
      const isUnlockedForEdit = state.unlockEditingOrders.has(String(order.orderId));
      const isLocked = isCancelledByAdmin || (isInvoiceSent && !isUnlockedForEdit);
      const hasSharedLine = state.sharedLineOrders.has(String(order.orderId));
      const sentStamp = !isCancelledByAdmin && isInvoiceSent && isLocked
        ? order.paymentStatus === "ชำระแล้ว"
          ? `<div class="pointer-events-none absolute inset-0 flex items-center justify-center z-10">
              <div class="border-4 border-dashed border-emerald-500/80 text-emerald-600 bg-emerald-50/85 font-black text-xl sm:text-2xl px-6 py-2 rounded-2xl tracking-wider uppercase transform -rotate-12 shadow-md text-center">
                <div>✓ ชำระแล้ว</div>
                <div class="text-xs font-bold text-emerald-700 mt-0.5 tracking-normal">🟢 รับเงินเรียบร้อย</div>
              </div>
            </div>`
          : `<div class="pointer-events-none absolute inset-0 flex items-center justify-center z-10">
              <div class="border-4 border-dashed border-red-500/80 text-red-600 bg-red-50/85 font-black text-xl sm:text-2xl px-6 py-2 rounded-2xl tracking-wider uppercase transform -rotate-12 shadow-md text-center">
                <div>✓ ส่งบิลแล้ว</div>
                <div class="text-xs font-bold text-red-700 mt-0.5 tracking-normal">🔴 ค้างจ่าย ${order.invoiceSentAt ? `(${escapeHtml(order.invoiceSentAt)})` : ""}</div>
              </div>
            </div>`
        : "";
      const vegTotal = (order.items || []).reduce((sum, item, idx) => {
        const isPacked = isInvoiceSent
          ? (Number(item.qty) > 0 && item.unavailable !== true)
          : (state.packedItems[`${order.orderId}_${idx}`] === true);
        const price = getUnitPrice(item);
        return sum + (isPacked && price !== "" ? (Number(item.qty) || 0) * (Number(price) || 0) : 0);
      }, 0);
      const addOnTotal = Number(order.addOnPrice) || 0;
      const initialOrderTotal = vegTotal + addOnTotal;

      return `<article data-order-card="${escapeHtml(order.orderId)}" class="relative overflow-hidden rounded-2xl border-2 p-2.5 shadow-sm space-y-2 ${isCancelledByAdmin ? "bg-red-50/70 border-red-300" : order.done ? "bg-gray-50 opacity-80" : order.checked ? "bg-amber-50/40 border-amber-400" : "bg-white border-gray-200"}">
        ${sentStamp}
        ${isCancelledByAdmin ? `<div class="p-2.5 bg-red-100 border border-red-300 rounded-xl text-red-800 text-xs font-bold">❌ ออเดอร์ถูกยกเลิกโดยแอดมิน · ${escapeHtml(order.adminCancelledAt)} น.</div>` : ""}
        <div class="flex justify-between items-start border-b pb-2 gap-2">
          <div class="min-w-0"><h3 class="font-extrabold text-base truncate">🏪 ${escapeHtml(order.customerName)}</h3>
            <div class="text-[10px] text-emerald-800 truncate">🕐 ${escapeHtml(formatOrderTime(order.timestamp))} · ${escapeHtml(order.orderId)}</div></div>
          <div class="flex flex-col items-end gap-1 shrink-0">
            <span class="text-[10px] font-bold">${status}</span>
            ${isCancelledByAdmin ? "" : `<button data-action="admin-cancel-order" data-order-id="${escapeHtml(order.orderId)}" data-shop-name="${escapeHtml(order.customerName)}" ${isLocked ? "disabled" : ""} class="px-2 py-1 rounded-lg text-xs font-bold border transition shrink-0 ${isLocked ? "bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed" : "bg-red-50 hover:bg-red-100 text-red-600 border-red-200"}" title="ยกเลิกบิลนี้">
              🗑️ ยกเลิกบิล
            </button>`}
          </div>
        </div>
        <div class="space-y-1.5">${order.items.map((item, index) => {
          const key = `${order.orderId}_${index}`;
          const checked = state.packedItems[key] === true;
          const unavailable = !checked || item.unavailable === true || Number(item.qty) === 0;
          const edited = item.originalQty !== undefined && Number(item.originalQty) !== Number(item.qty);
          const unitPrice = getUnitPrice(item);
          const lineTotal = checked && unitPrice !== ""
            ? (Number(item.qty) || 0) * (Number(unitPrice) || 0)
            : 0;
          const rowClass = isLocked && unavailable
            ? "bg-gray-100 opacity-60 border-dashed border-gray-300"
            : checked ? "bg-emerald-50/70 border-emerald-300 opacity-70" : "bg-white border-gray-200";
          return `<div class="p-2.5 rounded-xl border flex items-center justify-between gap-2 transition-colors ${rowClass}">
            <label class="flex items-center gap-2.5 min-w-0 flex-1 cursor-pointer">
              <input type="checkbox" data-action="toggle-packed" data-order="${escapeHtml(order.orderId)}" data-index="${index}" ${checked ? "checked" : ""} ${isLocked ? "disabled" : ""} class="w-4 h-4 rounded text-emerald-600 shrink-0">
              <div class="min-w-0">
                <span class="font-extrabold text-sm text-gray-800 truncate block ${checked ? "line-through text-gray-400" : ""}">${escapeHtml(item.name)}</span>
                ${edited ? `<span class="text-[10px] text-amber-700 font-semibold block">เดิม ${escapeHtml(item.originalQty)} → ได้ ${escapeHtml(item.qty)}</span>` : ""}
                ${isLocked && unavailable ? '<span class="text-[10px] bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-bold">ตัดยอด 0 (ของหมด)</span>' : ""}
              </div>
            </label>
            <div class="flex items-center gap-1.5 shrink-0">
              <div class="flex items-center gap-1 bg-gray-50 px-2 py-1 rounded-lg border border-gray-200">
                <span class="font-black text-xs text-gray-800 whitespace-nowrap">${escapeHtml(item.qty)} ${escapeHtml(item.unit)}</span>
                ${isLocked ? "" : `<button data-action="edit-qty" data-order="${escapeHtml(order.orderId)}" data-index="${index}" class="text-[11px] text-gray-400 hover:text-emerald-700" title="ปรับจำนวน">✏️</button>`}
              </div>
              <span class="text-xs text-gray-400">×</span>
              <div class="flex items-center">
                <input type="number" min="0" step="0.5" inputmode="decimal" data-action="change-item-price" data-unit-price data-index="${index}" value="${escapeHtml(unitPrice)}" placeholder="ราคา" aria-label="ราคาต่อหน่วย ${escapeHtml(item.name)}" ${isLocked ? "disabled" : ""} class="w-16 p-1 text-center font-bold text-xs bg-gray-50 border border-gray-300 rounded-lg focus:bg-white focus:ring-1 focus:ring-emerald-500 focus:outline-none">
                <span class="text-[10px] text-gray-400 ml-1">฿</span>
              </div>
              <span class="w-12 text-right font-black text-xs text-emerald-700 whitespace-nowrap">
                ${lineTotal > 0 ? `= <span data-line-total="${lineTotal}">${lineTotal.toLocaleString("th-TH", { maximumFractionDigits: 2 })}</span> ฿` : `= <span data-line-total="${lineTotal}">-</span>`}
              </span>
            </div>
          </div>`;
        }).join("")}</div>
        ${order.addOnNote ? `<div class="p-2.5 bg-amber-50 rounded-xl border border-amber-200 flex items-center justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0 flex-1">
            <span class="text-amber-900 font-bold text-xs shrink-0">📝 สั่งพิเศษ:</span>
            <span id="addonText_${escapeHtml(order.orderId)}" class="text-xs font-semibold text-amber-950 truncate">${escapeHtml(order.addOnNote)}</span>
            <button ${isLocked ? 'disabled class="hidden"' : `data-action="edit-addon-text" data-order="${escapeHtml(order.orderId)}"`} class="text-[11px] text-amber-700 hover:text-amber-900 underline shrink-0">✏️ แก้ไข</button>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <span class="text-[11px] text-gray-500">ราคา:</span>
            <input type="number" min="0" step="1" placeholder="0" value="${Number(order.addOnPrice) || ""}" ${isLocked ? "disabled" : ""} data-addon-price data-action="change-addon-price" class="w-16 p-1 text-center font-bold text-xs bg-white border border-amber-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-amber-500">
            <span class="text-[10px] text-gray-500">฿</span>
          </div>
        </div>` : ""}
        ${order.notes ? `
          <div class="p-2.5 bg-sky-50 border-2 border-sky-300 rounded-xl text-xs text-sky-950 flex items-start gap-2 shadow-sm my-1">
            <span class="text-base leading-none">💬</span>
            <div class="min-w-0 flex-1">
              <strong class="text-sky-900 block font-bold text-[11px] uppercase tracking-wide">ข้อความฝากถึงแม่ทิพย์:</strong>
              <span class="font-semibold text-xs leading-relaxed text-sky-950 break-words">${escapeHtml(order.notes)}</span>
            </div>
          </div>
        ` : ""}
        <div class="flex justify-between items-center border-t pt-2">
          <span class="text-sm font-extrabold text-gray-800">ยอดรวมสุทธิ</span>
          <strong class="text-base text-emerald-800"><span data-order-total>${initialOrderTotal.toLocaleString("th-TH", { maximumFractionDigits: 2 })}</span> บาท</strong>
        </div>
        ${isCancelledByAdmin ? "" : `<div class="grid grid-cols-4 gap-1.5 pt-2 border-t border-gray-100">
          <button ${isLocked ? "disabled" : `data-action="save-invoice" data-order-id="${escapeHtml(order.orderId)}"`} class="min-w-0 py-2 px-1 rounded-xl text-[10px] sm:text-xs font-bold flex items-center justify-center gap-1 transition shadow-sm ${isLocked ? "bg-slate-700 text-white cursor-default" : "bg-emerald-600 hover:bg-emerald-700 text-white"}">
            <span>${isLocked ? "✓ ส่งแล้ว" : isInvoiceSent ? "📤 ส่งใหม่" : "📤 ส่งบิล"}</span>
          </button>
          ${isLocked
            ? `<button data-action="unlock-order-edit" data-order-id="${escapeHtml(order.orderId)}" class="min-w-0 py-2 px-1 rounded-xl text-[10px] sm:text-xs font-bold bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 flex items-center justify-center gap-1 shadow-sm transition"><span>✏️ แก้ไข</span></button>`
            : isUnlockedForEdit
              ? `<button data-action="cancel-unlock-order" data-order-id="${escapeHtml(order.orderId)}" class="min-w-0 py-2 px-1 rounded-xl text-[10px] sm:text-xs font-bold bg-gray-100 hover:bg-gray-200 text-gray-600 flex items-center justify-center transition"><span>ยกเลิก</span></button>`
              : '<span aria-hidden="true"></span>'}
          <button data-action="toggle-payment" data-order="${escapeHtml(order.orderId)}" class="min-w-0 py-2 px-1 rounded-xl text-[10px] sm:text-xs font-bold border flex items-center justify-center gap-1 shadow-sm transition ${order.paymentStatus === "ชำระแล้ว" ? "bg-emerald-50 text-emerald-700 border-emerald-300" : "bg-red-50 text-red-600 border-red-200"}">
            <span>${order.paymentStatus === "ชำระแล้ว" ? "🟢 จ่ายแล้ว" : "🔴 ค้างจ่าย"}</span>
          </button>
          <button data-action="share-order-invoice" data-order="${escapeHtml(order.orderId)}" class="min-w-0 py-2 px-1 rounded-xl text-[10px] sm:text-xs font-bold border flex items-center justify-center gap-1 shadow-sm transition ${hasSharedLine ? "bg-emerald-800 text-white border-emerald-900" : "bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border-emerald-300"}">
            <span>${hasSharedLine ? "✓ ส่ง LINE" : "📲 LINE"}</span>
          </button>
        </div>`}
      </article>`;
    };
    const cancelledSection = cancelledOrders.length
      ? `<div class="text-center pt-2">
          <button data-action="toggle-cancelled-orders" class="text-xs text-gray-400 hover:text-gray-600 underline">
            ${state.showCancelledOrders ? "▲ ซ่อนบิลที่ยกเลิก" : `▼ แสดงบิลที่ยกเลิกแล้ว (${cancelledOrders.length} บิล)`}
          </button>
        </div>
        <div id="cancelledOrdersContainer" class="${state.showCancelledOrders ? "" : "hidden"} space-y-2 mt-2">
          ${cancelledOrders.map(renderOrderCard).join("")}
        </div>`
      : "";
    container.innerHTML = `${filterBar}
      ${visibleOrders.length ? visibleOrders.map(renderOrderCard).join("") : '<div class="text-center py-6 text-gray-400 bg-white rounded-2xl border">ไม่มีบิลในตัวกรองนี้</div>'}
      ${cancelledSection}`;
  }

  async function saveOrderPricing(orderId, button) {
    const order = state.currentOrders.find(item => String(item.orderId) === String(orderId));
    const card = button.closest("[data-order-card]");
    if (!order || !card) return;
    if (!await confirmUnpickedItems(order)) return;

    const confirmResult = await Swal.fire({
      title: 'ยืนยันบันทึก & ส่งใบส่งของ?',
      html: `ต้องการบันทึกราคาและส่งยอดเงินให้ร้าน <b>${escapeHtml(order.customerName)}</b> ใช่หรือไม่?<br><span class="text-xs text-gray-500">(เมื่อส่งแล้ว ลูกค้าจะเห็นใบส่งของและไม่สามารถแก้ไข/ยกเลิกออเดอร์ได้)</span>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'ใช่, บันทึกและส่ง',
      cancelButtonText: 'ตรวจสอบก่อน',
      confirmButtonColor: '#059669',
      cancelButtonColor: '#6b7280'
    });
    if (!confirmResult.isConfirmed) return;

    const items = buildPricedInvoiceItems(order, card);
    if (items.some(item => !item.unavailable &&
        (!Number.isFinite(item.unitPrice) || item.unitPrice < 0))) {
      alert("กรุณากรอกราคาต่อหน่วยให้ครบทุกสินค้าที่ติ๊กรับของ (ราคาต้องไม่ติดลบ)");
      return;
    }
    const addOnPriceInput = card.querySelector("[data-addon-price]");
    const addOnPrice = order.addOnNote
      ? Number(addOnPriceInput && addOnPriceInput.value || 0)
      : 0;
    if (!Number.isFinite(addOnPrice) || addOnPrice < 0) {
      alert("กรุณากรอกราคาของสั่งพิเศษเป็นจำนวนตั้งแต่ 0 บาทขึ้นไป");
      return;
    }

    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = "กำลังบันทึก...";
    try {
      const result = await postAction({
        action: "updateOrderPricing",
        orderId,
        addOnNote: order.addOnNote || "",
        addOnPrice,
        items: items.map(({ name, unit, qty, unitPrice, unavailable }) =>
          ({ name, unit, qty, unitPrice, unavailable }))
      });
      items.forEach((item, index) => {
        order.items[index].qty = item.qty;
        order.items[index].unitPrice = item.unitPrice;
        order.items[index].unavailable = item.unavailable;
        if (!item.unavailable) state.customPrices[priceStorageKey(item)] = item.unitPrice;
      });
      order.totalAmount = Number(result.totalAmount) || 0;
      order.addOnPrice = addOnPrice;
      order.hasPricing = true;
      order.invoiceSentAt = result.invoiceSentAt ||
        new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) + " น.";
      state.unlockEditingOrders.delete(String(orderId));
      try {
        localStorage.setItem("market_custom_prices", JSON.stringify(state.customPrices));
      } catch (error) {
        console.warn("บันทึกราคาต่อหน่วยไว้ในเครื่องไม่สำเร็จ", error);
      }
      await Swal.fire({
        icon: 'success',
        title: 'บันทึกและส่งใบส่งของสำเร็จ!',
        text: `ส่งยอดให้ ${order.customerName} แล้ว · ยอดรวม ${order.totalAmount.toLocaleString("th-TH", { maximumFractionDigits: 2 })} บาท`,
        confirmButtonText: 'ตกลง',
        confirmButtonColor: '#059669'
      });
      renderDashboard();
    } catch (error) {
      await Swal.fire({
        icon: 'error',
        title: 'บันทึกหรือส่งใบส่งของไม่สำเร็จ',
        text: error.message,
        confirmButtonColor: '#dc2626'
      });
      console.error("บันทึกราคาออเดอร์ไม่สำเร็จ", error);
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  async function adminCancelOrder(orderId, shopName) {
    if (!window.confirm(`ยืนยันยกเลิกบิล ${orderId} ของร้าน "${shopName}" ใช่หรือไม่?\n(ยอดผักในตลาดจะถูกหักออกทันที)`)) {
      return;
    }

    try {
      const result = await postAction({ action: "cancelOrder", orderId });
      if (result.success !== true || String(result.orderId) !== String(orderId)) {
        throw new Error(result.message || "Apps Script ไม่ยืนยันการยกเลิกบิล");
      }
      const order = state.currentOrders.find(item => String(item.orderId) === String(orderId));
      if (order) {
        order.status = "ยกเลิกแล้ว";
        order.adminCancelledAt = result.adminCancelledAt;
      }
      renderDashboard();
    } catch (error) {
      alert(`ยกเลิกบิลไม่สำเร็จ: ${error.message}`);
      console.error("แอดมินยกเลิกบิลไม่สำเร็จ", error);
    }
  }

  async function togglePaymentStatusWithConfirm(orderId, currentStatus, shopName, button) {
    const order = state.currentOrders.find(item => String(item.orderId) === String(orderId));
    if (!order) return;
    const card = button && button.closest("[data-order-card]");
    const nextStatus = currentStatus === "ชำระแล้ว" ? "ค้างชำระ" : "ชำระแล้ว";
    const isPaying = nextStatus === "ชำระแล้ว";
    const confirmation = await Swal.fire({
      title: 'ยืนยันเปลี่ยนสถานะ?',
      html: `ต้องการเปลี่ยนสถานะร้าน <b>${escapeHtml(shopName)}</b><br>เป็น <b class="${isPaying ? 'text-emerald-600' : 'text-amber-600'}">"${nextStatus}"</b> ใช่หรือไม่?`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'ใช่, เปลี่ยนสถานะ',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: isPaying ? '#059669' : '#d97706',
      cancelButtonColor: '#6b7280'
    });
    if (!confirmation.isConfirmed) return;

    if (button) button.disabled = true;
    let pricingSaved = false;
    let invoiceAddOnPrice = 0;
    try {
      let pricedItems = null;
      if (isPaying) {
        if (!card) throw new Error("ไม่พบการ์ดออเดอร์สำหรับอ่านราคาสินค้า");
        if (!await confirmUnpickedItems(order)) return;
        pricedItems = buildPricedInvoiceItems(order, card);
        if (pricedItems.some(item => !item.unavailable &&
            (!Number.isFinite(item.unitPrice) || item.unitPrice < 0))) {
          throw new Error("กรุณากรอกราคาต่อหน่วยให้ครบทุกสินค้าที่ติ๊กรับของ (ราคาต้องไม่ติดลบ) ก่อนเปลี่ยนเป็นชำระแล้ว");
        }
        const addOnPriceInput = card.querySelector("[data-addon-price]");
        invoiceAddOnPrice = order.addOnNote
          ? Number(addOnPriceInput && addOnPriceInput.value || 0)
          : 0;
        if (!Number.isFinite(invoiceAddOnPrice) || invoiceAddOnPrice < 0) {
          throw new Error("กรุณากรอกราคาของสั่งพิเศษเป็นจำนวนตั้งแต่ 0 บาทขึ้นไป");
        }
      }

      Swal.fire({
        title: isPaying ? 'กำลังบันทึกใบส่งของและสถานะ...' : 'กำลังอัปเดตสถานะ...',
        allowOutsideClick: false,
        didOpen: () => {
          Swal.showLoading();
        }
      });
      if (isPaying) {
        const pricingResult = await postAction({
          action: "updateOrderPricing",
          orderId,
          addOnNote: order.addOnNote || "",
          addOnPrice: invoiceAddOnPrice,
          items: pricedItems.map(({ name, unit, qty, unitPrice, unavailable }) =>
            ({ name, unit, qty, unitPrice, unavailable }))
        });
        pricedItems.forEach((item, index) => {
          order.items[index].qty = item.qty;
          order.items[index].unitPrice = item.unitPrice;
          order.items[index].unavailable = item.unavailable;
          if (!item.unavailable) state.customPrices[priceStorageKey(item)] = item.unitPrice;
        });
        order.totalAmount = Number(pricingResult.totalAmount) || 0;
        order.addOnPrice = invoiceAddOnPrice;
        order.hasPricing = true;
        order.invoiceSentAt = pricingResult.invoiceSentAt ||
          new Date().toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) + " น.";
        state.unlockEditingOrders.delete(String(orderId));
        pricingSaved = true;
        try {
          localStorage.setItem("market_custom_prices", JSON.stringify(state.customPrices));
        } catch (error) {
          console.warn("บันทึกราคาต่อหน่วยไว้ในเครื่องไม่สำเร็จ", error);
        }
      }
      await postAction({ action: "updatePaymentStatus", orderId, paymentStatus: nextStatus });
      order.paymentStatus = nextStatus;
      renderDashboard();
      await Swal.fire({
        icon: 'success',
        title: isPaying ? 'บันทึกใบส่งของและอัปเดตสถานะเรียบร้อย!' : 'อัปเดตเรียบร้อย!',
        text: isPaying
          ? `เปลี่ยนเป็น "${nextStatus}" แล้ว · ยอดรวม ${order.totalAmount.toLocaleString("th-TH", { maximumFractionDigits: 2 })} บาท`
          : `เปลี่ยนเป็น "${nextStatus}" แล้ว`,
        timer: 1500,
        showConfirmButton: false
      });
    } catch (error) {
      if (pricingSaved) renderDashboard();
      await Swal.fire({
        icon: 'error',
        title: pricingSaved ? 'บันทึกใบส่งของแล้ว แต่เปลี่ยนสถานะไม่สำเร็จ' : 'เกิดข้อผิดพลาด',
        text: error.message
      });
      console.error("เปลี่ยนสถานะชำระเงินไม่สำเร็จ", error);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function shareOrderInvoice(orderId, button) {
    const order = state.currentOrders.find(item => String(item.orderId) === String(orderId));
    const card = button && button.closest("[data-order-card]");
    if (!order) return;
    const inputs = card ? [...card.querySelectorAll("[data-unit-price]")] : [];
    if (inputs.some(input =>
      state.packedItems[`${order.orderId}_${Number(input.dataset.index)}`] === true &&
      (input.value === "" || !Number.isFinite(Number(input.value)) || Number(input.value) < 0))) {
      alert("กรุณากรอกราคาต่อหน่วยให้ครบทุกสินค้า ก่อนแชร์ใบส่งของ");
      return;
    }

    const message = orderInvoiceText(order, card);
    try {
      await navigator.clipboard.writeText(message);
    } catch (error) {
      if (window.prompt("คัดลอกข้อความสรุปยอดนี้เพื่อส่งให้ลูกค้า:", message) === null) return;
    }
    state.sharedLineOrders.add(String(orderId));
    try {
      localStorage.setItem("market_shared_line_orders", JSON.stringify([...state.sharedLineOrders]));
    } catch (error) {
      console.warn("บันทึกสถานะการแชร์ LINE ไว้ในเครื่องไม่สำเร็จ", error);
    }
    renderPackingTab();
    window.location.href = `line://msg/text/${encodeURIComponent(message)}`;
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
    if (tab === "shopHistory") renderShopHistory();
  }

  function populateHistoryShopSelect() {
    const select = document.getElementById("customerHistoryShopSelect");
    if (!select) return;
    const selectedShop = select.value || state.selectedHistoryShop || "";
    select.innerHTML = `<option value="">เลือกร้านค้า...</option>${(state.allShops || []).map(shop =>
      `<option value="${escapeHtml(shop.name)}">${escapeHtml(shop.name)}</option>`
    ).join("")}`;
    if (selectedShop && (state.allShops || []).some(shop => shop.name === selectedShop)) {
      select.value = selectedShop;
      state.selectedHistoryShop = selectedShop;
    }
  }

  async function loadShopHistory(shopName) {
    const ordersContainer = document.getElementById("customerHistoryOrders");
    const summary = document.getElementById("customerHistorySummary");
    const requestId = ++shopHistoryRequestId;
    if (!shopName) {
      state.selectedHistoryShop = "";
      state.shopHistoryOrders = [];
      if (summary) {
        summary.classList.add("hidden");
        summary.innerHTML = "";
      }
      if (ordersContainer) {
        ordersContainer.innerHTML = '<div class="text-center py-8 text-gray-400 bg-white rounded-2xl border">เลือกร้านค้าเพื่อดูประวัติ</div>';
      }
      return;
    }

    state.selectedHistoryShop = shopName;
    if (ordersContainer) {
      ordersContainer.innerHTML = '<div class="text-center py-8 text-gray-400 bg-white rounded-2xl border">กำลังโหลดประวัติร้านค้า...</div>';
    }
    try {
      let result;
      try {
        result = await requestJson(
          `${config.APPS_SCRIPT_URL}?action=getShopFullHistory&shopName=${encodeURIComponent(shopName)}`
        );
      } catch (error) {
        if (error.message !== "Invalid action") throw error;
        result = await requestJson(
          `${config.APPS_SCRIPT_URL}?action=getCustomerHistory&customerName=${encodeURIComponent(shopName)}`
        );
      }
      if (requestId !== shopHistoryRequestId || state.selectedHistoryShop !== shopName) return;
      state.shopHistoryOrders = Array.isArray(result.orders) ? result.orders : [];
      renderShopHistory();
    } catch (error) {
      if (requestId !== shopHistoryRequestId || state.selectedHistoryShop !== shopName) return;
      state.shopHistoryOrders = [];
      if (summary) {
        summary.classList.add("hidden");
        summary.innerHTML = "";
      }
      if (ordersContainer) {
        ordersContainer.innerHTML = `<div class="text-center py-8 text-red-600 bg-white rounded-2xl border">โหลดประวัติไม่สำเร็จ: ${escapeHtml(error.message)}</div>`;
      }
      console.error("โหลดประวัติร้านค้าไม่สำเร็จ", error);
    }
  }

  function renderShopHistory() {
    const summary = document.getElementById("customerHistorySummary");
    const container = document.getElementById("customerHistoryOrders");
    const shopName = state.selectedHistoryShop;
    if (!summary || !container) return;
    if (!shopName) {
      summary.classList.add("hidden");
      container.innerHTML = '<div class="text-center py-8 text-gray-400 bg-white rounded-2xl border">เลือกร้านค้าเพื่อดูประวัติ</div>';
      return;
    }

    const orders = (state.shopHistoryOrders || []).slice().sort((a, b) =>
      getOrderTimestamp(b) - getOrderTimestamp(a));
    const unpaidOrders = orders.filter(order =>
      order.paymentStatus !== "ชำระแล้ว" && String(order.status || "").trim() !== "ยกเลิกแล้ว");
    const unpaidTotal = unpaidOrders.reduce((sum, order) => sum + (Number(order.totalAmount) || 0), 0);
    summary.innerHTML = `
      <div class="grid grid-cols-3 gap-2 bg-white p-3 rounded-2xl border border-gray-200 shadow-sm text-center">
        <div><p class="text-[10px] text-gray-500">สั่งทั้งหมด</p><p class="font-extrabold text-gray-900">${orders.length} ครั้ง</p></div>
        <div><p class="text-[10px] text-amber-700">บิลค้างชำระ</p><p class="font-extrabold text-amber-800">${unpaidOrders.length} บิล</p></div>
        <div><p class="text-[10px] text-amber-700">ยอดค้าง</p><p class="font-extrabold text-amber-800">${unpaidTotal.toLocaleString("th-TH", { maximumFractionDigits: 2 })} บาท</p></div>
      </div>`;
    summary.classList.remove("hidden");

    if (!orders.length) {
      container.innerHTML = '<div class="text-center py-8 text-gray-400 bg-white rounded-2xl border">ร้านนี้ยังไม่มีประวัติการสั่งซื้อ</div>';
      return;
    }

    container.innerHTML = orders.map(order => {
      const items = Array.isArray(order.items) ? order.items : [];
      const isCancelled = String(order.status || "").trim() === "ยกเลิกแล้ว";
      const isPaid = order.paymentStatus === "ชำระแล้ว";
      return `<article class="bg-white p-3 rounded-2xl border border-gray-200 shadow-sm space-y-2">
        <div class="flex justify-between items-start gap-2 border-b pb-2">
          <div class="min-w-0">
            <h3 class="font-extrabold text-sm text-gray-900">${escapeHtml(order.orderDate)} · ${escapeHtml(order.orderId)}</h3>
            <p class="text-[11px] text-gray-500">${escapeHtml(formatOrderTime(order.timestamp))}</p>
          </div>
          <div class="text-right shrink-0">
            <p class="font-black text-emerald-800">${(Number(order.totalAmount) || 0).toLocaleString("th-TH", { maximumFractionDigits: 2 })} บาท</p>
            <p class="text-[10px] font-bold ${isCancelled ? "text-gray-500" : isPaid ? "text-emerald-700" : "text-red-700"}">${isCancelled ? "ยกเลิกแล้ว" : isPaid ? "ชำระแล้ว" : "ค้างชำระ"}</p>
          </div>
        </div>
        <div class="space-y-1">${items.map(item => {
          const unavailable = item.unavailable === true || Number(item.qty) === 0 ||
            (order.hasPricing && Number(item.unitPrice) === 0);
          return unavailable
            ? `<div class="flex justify-between text-xs text-gray-400"><span class="line-through">${escapeHtml(item.name)} <span class="bg-red-100 text-red-700 px-1 rounded font-bold">ของหมด/ตัดยอด 0</span></span><span>-</span></div>`
            : `<div class="flex justify-between gap-2 text-xs text-emerald-800"><span>${escapeHtml(item.name)} · ${escapeHtml(item.qty)} ${escapeHtml(item.unit)}${item.unitPrice !== undefined ? ` × ${Number(item.unitPrice).toLocaleString("th-TH")} บาท/${escapeHtml(item.unit)}` : ""}</span><span class="whitespace-nowrap font-bold">${item.unitPrice !== undefined ? `${(Number(item.qty) * Number(item.unitPrice)).toLocaleString("th-TH", { maximumFractionDigits: 2 })} บาท` : ""}</span></div>`;
        }).join("")}</div>
        ${order.addOnNote ? `<p class="rounded-lg bg-amber-50 p-2 text-xs text-amber-900"><b>สั่งพิเศษ:</b> ${escapeHtml(order.addOnNote)}</p>` : ""}
        ${!isCancelled ? `<button data-action="toggle-history-payment" data-order-id="${escapeHtml(order.orderId)}" class="w-full rounded-xl border px-3 py-2 text-xs font-bold ${isPaid ? "bg-amber-50 border-amber-300 text-amber-800" : "bg-emerald-50 border-emerald-300 text-emerald-800"}">${isPaid ? "เปลี่ยนเป็นค้างชำระ" : "ทำเครื่องหมายชำระแล้ว"}</button>` : ""}
      </article>`;
    }).join("");
  }

  async function toggleHistoryPayment(orderId) {
    const order = (state.shopHistoryOrders || []).find(item => String(item.orderId) === String(orderId));
    if (!order) return;
    const nextStatus = order.paymentStatus === "ชำระแล้ว" ? "ค้างชำระ" : "ชำระแล้ว";
    const confirmation = await Swal.fire({
      icon: "question",
      title: "ยืนยันเปลี่ยนสถานะชำระเงิน?",
      html: `บิล <b>${escapeHtml(order.orderId)}</b> ของร้าน <b>${escapeHtml(state.selectedHistoryShop)}</b><br>เปลี่ยนเป็น <b>${nextStatus}</b> ใช่หรือไม่?`,
      showCancelButton: true,
      confirmButtonText: "ยืนยัน",
      cancelButtonText: "กลับ",
      confirmButtonColor: nextStatus === "ชำระแล้ว" ? "#059669" : "#d97706"
    });
    if (!confirmation.isConfirmed) return;

    try {
      await postAction({ action: "updatePaymentStatus", orderId, paymentStatus: nextStatus });
      const currentOrder = state.currentOrders.find(item => String(item.orderId) === String(orderId));
      if (currentOrder) currentOrder.paymentStatus = nextStatus;
      renderDashboard();
      await loadShopHistory(state.selectedHistoryShop);
      await Swal.fire({
        icon: "success",
        title: "อัปเดตสถานะชำระเงินแล้ว",
        timer: 1300,
        showConfirmButton: false
      });
    } catch (error) {
      await Swal.fire({ icon: "error", title: "อัปเดตไม่สำเร็จ", text: error.message });
      console.error("อัปเดตสถานะชำระเงินจากประวัติไม่สำเร็จ", error);
    }
  }

  function formatPhoneNumber(phone) {
    if (!phone) return "";
    let clean = String(phone).replace(/\D/g, "");
    if (!clean) return "";
    if (clean.length === 9 && !clean.startsWith("0")) {
      clean = `0${clean}`;
    }
    if (clean.length === 10) {
      return `${clean.slice(0, 3)}-${clean.slice(3, 6)}-${clean.slice(6)}`;
    }
    if (clean.length === 9) {
      return `${clean.slice(0, 2)}-${clean.slice(2, 5)}-${clean.slice(5)}`;
    }
    return clean;
  }

  function generateShopId() {
    let maxNum = 0;
    (state.allShops || []).forEach(shop => {
      const match = String(shop.id || "").match(/^SH-(\d+)$/i);
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10));
    });
    return `SH-${String(maxNum + 1).padStart(3, "0")}`;
  }

  async function createShop() {
    const nameInput = document.getElementById("newShopName");
    const phoneInput = document.getElementById("newShopPhone");
    const button = document.getElementById("createShopButton");
    const status = document.getElementById("shopCopyStatus");
    const name = nameInput.value.trim();
    const formattedContact = formatPhoneNumber(phoneInput.value.trim());

    if (!name) {
      status.textContent = "กรุณากรอกชื่อร้านค้า";
      status.className = "text-xs text-red-700 font-bold";
      status.classList.remove("hidden");
      nameInput.focus();
      return;
    }

    button.disabled = true;
    status.textContent = "กำลังบันทึกร้านค้า...";
    status.className = "text-xs text-emerald-700 font-bold";
    status.classList.remove("hidden");

    try {
      const shopId = generateShopId();
      const result = await postAction({
        action: "registerShop",
        shopId,
        shopName: name,
        contact: formattedContact
      });
      if (result.success !== true) {
        throw new Error(result.error || result.message || "Apps Script ไม่ยืนยันการบันทึกร้านค้า");
      }

      const savedShopId = String(result.shopId || shopId);
      state.allShops.push({ id: savedShopId, name, contact: formattedContact });
      renderShops();
      nameInput.value = "";
      phoneInput.value = "";

      const link = new URL("index.html", window.location.href);
      link.searchParams.set("id", savedShopId);
      try {
        await navigator.clipboard.writeText(link.href);
        status.textContent = `บันทึกร้าน ${name} (${savedShopId}) และคัดลอกลิงก์แล้ว!`;
        status.className = "text-xs text-emerald-700 font-bold";
      } catch (error) {
        status.textContent = `เพิ่มร้าน "${name}" แล้ว แต่คัดลอกอัตโนมัติไม่ได้ กรุณาคัดลอกลิงก์ด้านล่าง`;
        status.className = "text-xs text-amber-700 font-bold";
        window.prompt("ร้านค้าถูกบันทึกแล้ว กรุณาคัดลอกลิงก์นี้:", link.href);
      }
      status.classList.remove("hidden");
    } catch (error) {
      status.textContent = `เพิ่มร้านค้าไม่สำเร็จ: ${error.message}`;
      status.className = "text-xs text-red-700 font-bold";
      status.classList.remove("hidden");
      console.error("เพิ่มร้านค้าไม่สำเร็จ", error);
    } finally {
      button.disabled = false;
    }
  }

  async function saveCutoffTime() {
    const input = document.getElementById("cutoffTimeInput");
    const status = document.getElementById("cutoffTimeStatus");
    const button = document.getElementById("saveCutoffTimeButton");
    const cutoffTime = input.value;
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(cutoffTime)) {
      status.textContent = "กรุณาระบุเวลาตัดรอบให้ถูกต้อง";
      status.className = "text-xs font-bold text-red-700";
      status.classList.remove("hidden");
      return;
    }

    button.disabled = true;
    status.textContent = "กำลังบันทึก...";
    status.className = "text-xs font-bold text-emerald-700";
    status.classList.remove("hidden");
    try {
      const result = await postAction({ action: "updateCutoffTime", cutoffTime });
      state.cutoffTime = result.cutoffTime;
      status.textContent = `บันทึกเวลาตัดรอบ ${state.cutoffTime} น. เรียบร้อยแล้ว`;
      status.className = "text-xs font-bold text-emerald-700";
    } catch (error) {
      status.textContent = `บันทึกไม่สำเร็จ: ${error.message}`;
      status.className = "text-xs font-bold text-red-700";
      console.error("บันทึกเวลาตัดรอบไม่สำเร็จ", error);
    } finally {
      button.disabled = false;
    }
  }

  function openShopEditor(id) {
    const shop = state.allShops.find(item => String(item.id) === String(id));
    if (!shop) return;
    document.getElementById("editShopId").value = shop.id;
    document.getElementById("editShopName").value = shop.name;
    document.getElementById("editShopPhone").value = shop.contact || "";
    const modal = document.getElementById("editShopModal");
    if (modal) {
      modal.classList.remove("hidden");
      modal.classList.add("flex");
    }
  }

  function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
      modal.classList.add("hidden");
      modal.classList.remove("flex");
    }
  }

  async function saveShop() {
    const id = document.getElementById("editShopId").value;
    const name = document.getElementById("editShopName").value.trim();
    const contact = formatPhoneNumber(document.getElementById("editShopPhone").value.trim());
    if (!name) return alert("กรุณากรอกชื่อร้านค้า");
    const button = document.getElementById("saveShopButton");
    if (button) button.disabled = true;
    try {
      await postAction({ action: "updateShop", shopId: id, shopName: name, contact });
      const shop = state.allShops.find(item => String(item.id) === String(id));
      if (shop) Object.assign(shop, { name, contact });
      renderShops();
      closeModal("editShopModal");
      alert("✅ บันทึกข้อมูลร้านค้าเรียบร้อยแล้ว");
    } catch (error) {
      alert(`แก้ไขร้านไม่สำเร็จ: ${error.message}`);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function deleteShop(id) {
    const shop = state.allShops.find(item => String(item.id) === String(id));
    if (!shop || !confirm(`ยืนยันลบร้าน "${shop.name}"? ลูกค้าจะใช้ลิงก์เดิมสั่งไม่ได้`)) return;
    try {
      await postAction({ action: "deleteShop", shopId: id });
      state.allShops = state.allShops.filter(item => String(item.id) !== String(id));
      renderShops();
      alert(`✓ ลบร้าน "${shop.name}" เรียบร้อยแล้ว`);
    } catch (error) {
      alert(`ลบร้านไม่สำเร็จ: ${error.message}`);
    }
  }

  function renderShops() {
    const container = document.getElementById("shopsListContainer");
    if (!container) return;
    const query = (document.getElementById("searchShopInput")?.value || "").trim().toLowerCase();
    const filtered = state.allShops.filter(shop =>
      `${shop.name} ${shop.id} ${shop.contact || ""} ${formatPhoneNumber(shop.contact)}`.toLowerCase().includes(query));

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
              <small class="text-gray-500 font-mono">${escapeHtml(shop.id)}</small> ${shop.contact ? `<small class="text-gray-500"> · 📞 ${escapeHtml(formatPhoneNumber(shop.contact))}</small>` : ""}
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
    const buttonContent = button.innerHTML;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.innerHTML = `
      <svg class="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"></path>
      </svg>
      <span>${state.selectedImageBase64 ? "กำลังอัปโหลดรูปและบันทึก..." : "กำลังบันทึกสินค้า..."}</span>
    `;
    button.classList.add("flex", "items-center", "justify-center", "gap-2", "opacity-80", "cursor-wait");
    status.textContent = state.selectedImageBase64 ? "กำลังอัปโหลดรูปและบันทึกข้อมูลสินค้า กรุณารอสักครู่" : "กำลังบันทึกข้อมูลสินค้า กรุณารอสักครู่";
    status.className = "text-sm font-semibold text-emerald-700";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.classList.remove("hidden");

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
      button.removeAttribute("aria-busy");
      button.innerHTML = buttonContent;
      button.classList.remove("flex", "items-center", "justify-center", "gap-2", "opacity-80", "cursor-wait");
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
      case "filter-orders":
        if (["pending", "paid", "all"].includes(control.dataset.filter)) {
          state.packingFilter = control.dataset.filter;
          renderPackingTab();
        }
        break;
      case "toggle-cancelled-orders":
        state.showCancelledOrders = !state.showCancelledOrders;
        renderPackingTab();
        break;
      case "show-unpaid-shops":
        await showUnpaidShopsModal();
        break;
      case "set-admin-font-size":
        setAdminFontSize(control.dataset.fontSize);
        break;
      case "quick-share-line":
        await shareOrderInvoice(control.dataset.orderId, control);
        break;
      case "quick-pay-order": {
        const orderId = control.dataset.orderId;
        const order = state.currentOrders.find(item => String(item.orderId) === String(orderId));
        if (!order || order.paymentStatus === "ชำระแล้ว") break;

        const amount = Number(order.totalAmount) || 0;
        const confirmation = await Swal.fire({
          title: "ยืนยันรับชำระเงิน?",
          html: `ต้องการบันทึกว่าร้าน <b>${escapeHtml(order.customerName || control.dataset.shopName)}</b><br>ชำระบิล <b>${escapeHtml(orderId)}</b><br>ยอดเงิน <b class="text-emerald-700">${amount.toLocaleString("th-TH", { maximumFractionDigits: 2 })} ฿</b> เรียบร้อยแล้ว ใช่หรือไม่?`,
          icon: "question",
          showCancelButton: true,
          confirmButtonText: "ใช่, ได้รับเงินแล้ว",
          cancelButtonText: "ยกเลิก",
          confirmButtonColor: "#059669",
          cancelButtonColor: "#6b7280"
        });
        if (!confirmation.isConfirmed) {
          await showUnpaidShopsModal();
          break;
        }

        Swal.fire({
          title: "กำลังบันทึกสถานะ...",
          allowOutsideClick: false,
          didOpen: () => Swal.showLoading()
        });
        try {
          const result = await postAction({
            action: "updatePaymentStatus",
            orderId,
            paymentStatus: "ชำระแล้ว"
          });
          if (result.success !== true) {
            throw new Error(result.message || "ระบบไม่ยืนยันการบันทึกสถานะชำระเงิน");
          }

          order.paymentStatus = "ชำระแล้ว";
          renderDashboard();
          Swal.close();
          await showUnpaidShopsModal();
        } catch (error) {
          await Swal.fire({
            icon: "error",
            title: "บันทึกไม่สำเร็จ",
            text: error.message
          });
          console.error("บันทึกสถานะชำระเงินจากรายการค้างไม่สำเร็จ", error);
          await showUnpaidShopsModal();
        }
        break;
      }
      case "create-shop":
        await createShop();
        break;
      case "save-cutoff-time":
        await saveCutoffTime();
        break;
      case "edit-shop":
        openShopEditor(control.dataset.shopId);
        break;
      case "close-edit-shop":
        closeModal("editShopModal");
        break;
      case "save-edit-shop":
        await saveShop();
        break;
      case "delete-shop":
        await deleteShop(control.dataset.shopId);
        break;
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
        const card = [...document.querySelectorAll("[data-order-card]")]
          .find(orderCard => orderCard.dataset.orderCard === control.dataset.order);
        if (card) calculateRenderedOrderTotal(card);
        break;
      }
      case "unlock-order-edit":
        state.unlockEditingOrders.add(String(control.dataset.orderId));
        renderPackingTab();
        break;
      case "cancel-unlock-order":
        state.unlockEditingOrders.delete(String(control.dataset.orderId));
        renderPackingTab();
        break;
      case "save-invoice":
        await saveOrderPricing(control.dataset.orderId, control);
        break;
      case "edit-addon-text": {
        const order = state.currentOrders.find(item => String(item.orderId) === String(control.dataset.order));
        if (!order || hasInvoiceBeenSent(order) && !state.unlockEditingOrders.has(String(order.orderId))) break;
        const result = await Swal.fire({
          title: "แก้ไขรายการสั่งพิเศษ",
          input: "text",
          inputValue: order.addOnNote || "",
          inputPlaceholder: "ระบุรายการสั่งพิเศษ",
          showCancelButton: true,
          confirmButtonText: "บันทึก",
          cancelButtonText: "ยกเลิก",
          confirmButtonColor: "#059669"
        });
        if (result.isConfirmed) {
          order.addOnNote = String(result.value || "").trim();
          if (!order.addOnNote) order.addOnPrice = 0;
          renderPackingTab();
        }
        break;
      }
      case "save-order-pricing":
        await saveOrderPricing(control.dataset.order, control);
        break;
      case "admin-cancel-order":
        await adminCancelOrder(control.dataset.orderId, control.dataset.shopName);
        break;
      case "toggle-payment":
        {
          const order = state.currentOrders.find(item => String(item.orderId) === String(control.dataset.order));
          if (order) {
            await togglePaymentStatusWithConfirm(
              control.dataset.order,
              order.paymentStatus,
              order.customerName,
              control
            );
          }
        }
        break;
      case "share-order-invoice":
        await shareOrderInvoice(control.dataset.order, control);
        break;
      case "toggle-history-payment":
        await toggleHistoryPayment(control.dataset.orderId);
        break;
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
        order.items.forEach(updatedItem => { delete updatedItem.unitPrice; });
        order.hasPricing = false;
        order.totalAmount = 0;
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
    document.getElementById("refreshOrdersBtn")?.addEventListener("click", async () => {
      const refreshed = await loadOrders();
      Swal.fire({
        toast: true,
        position: "top",
        icon: refreshed ? "success" : "error",
        title: refreshed ? "รีเฟรชข้อมูลล่าสุดแล้ว" : "รีเฟรชข้อมูลไม่สำเร็จ",
        showConfirmButton: false,
        timer: 1200
      });
    });
    document.getElementById("todayButton")?.addEventListener("click", () => {
      initializeDate();
      loadOrders();
    });
    document.getElementById("selectedDate")?.addEventListener("change", loadOrders);
    document.getElementById("customerHistoryShopSelect")?.addEventListener("change", event => {
      loadShopHistory(event.target.value);
    });

    // ค้นหาในคลังผัก
    document.getElementById("searchItemInput")?.addEventListener("input", renderVegetablesList);
    // ค้นหาร้านค้า
    document.getElementById("adminApp")?.addEventListener("input", event => {
      if (event.target.id === "searchShopInput") renderShops();
      if (event.target.matches("[data-unit-price]")) {
        const input = event.target;
        const card = input.closest("[data-order-card]");
        if (!card) return;
        const order = state.currentOrders.find(item => String(item.orderId) === card.dataset.orderCard);
        const item = order && order.items[Number(input.dataset.index)];
        const lineTotal = card.querySelectorAll("[data-line-total]")[Number(input.dataset.index)];
        if (!item || !lineTotal) return;
        const unitPrice = input.value === "" ? 0 : Number(input.value);
        const isPacked = state.packedItems[`${order.orderId}_${Number(input.dataset.index)}`] === true;
        const amount = isPacked
          ? (Number(item.qty) || 0) * (Number.isFinite(unitPrice) ? unitPrice : 0)
          : 0;
        lineTotal.dataset.lineTotal = String(amount);
        lineTotal.textContent = amount.toLocaleString("th-TH", { maximumFractionDigits: 2 });
        calculateRenderedOrderTotal(card);
        state.customPrices[priceStorageKey(item)] = input.value;
        try {
          localStorage.setItem("market_custom_prices", JSON.stringify(state.customPrices));
        } catch (error) {
          console.warn("บันทึกราคาต่อหน่วยไว้ในเครื่องไม่สำเร็จ", error);
        }
      }
      if (event.target.matches("[data-addon-price]")) {
        const card = event.target.closest("[data-order-card]");
        if (card) calculateRenderedOrderTotal(card);
      }
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
      initializeAdminFontSize();
      initializeDate();
      await loadComponents();
      initializeEvents();
      setMainMode("daily"); // เริ่มที่โหมดหน้างาน
      await Promise.all([loadOrders(), loadInitialData()]);
      scheduleMarketDateCutoff();
    } catch (error) {
      console.error("เริ่มต้นระบบไม่สำเร็จ", error);
    }
  }

  initialize();
})();