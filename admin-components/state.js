function readMarketStorage(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch (error) {
    console.warn(`ข้อมูล ${key} ใน localStorage ไม่ถูกต้อง`, error);
    return fallback;
  }
}

window.MarketState = {
  currentOrders: [],
  shopHistoryOrders: [],
  selectedHistoryShop: "",
  allShops: [],
  vegetables: [],
  units: ["กก.", "ขีด", "กรัม", "ลูก", "ถุง", "มัด", "ห่อ", "แพ็ค", "ตัว", "ถาด"],
  packedItems: readMarketStorage("market_packed_items", {}),
  boughtItems: new Set(readMarketStorage("market_bought_items", [])),
  customPrices: readMarketStorage("market_custom_prices", {}),
  editingContext: null,
  editingVegContext: null,
  selectedImageBase64: "",
  cutoffTime: "00:00",
  activeTab: "market",
  mainMode: "daily",
  packingFilter: "pending",
  showCancelledOrders: false
};
