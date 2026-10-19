// ==========================================
// การตั้งค่าชื่อชีต และ Folder ID สำหรับเก็บรูป
// ==========================================
const SHEET_ORDERS = "Orders";
const SHEET_SHOPS  = "Shops";
const SHEET_ITEMS  = "Items";
const SHEET_SETTINGS = "Settings";
const DRIVE_IMAGE_FOLDER_ID = "1SCeXszk1f7EHck0l5ANZdfz3byPtOKVR";

function getSettingsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_SETTINGS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_SETTINGS);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["Key", "Value"]);
  }
  return sheet;
}

function getCutoffTime() {
  const sheet = getSettingsSheet();
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === "cutoffTime") {
      const value = rows[i][1];
      if (value instanceof Date) {
        return Utilities.formatDate(value, "Asia/Bangkok", "HH:mm");
      }
      if (typeof value === "number" && value >= 0 && value < 1) {
        const minutes = Math.round(value * 24 * 60) % (24 * 60);
        return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      }
      const match = String(value || "").trim().match(/^(\d{2}):(\d{2})$/);
      return match && Number(match[1]) <= 23 && Number(match[2]) <= 59
        ? `${match[1]}:${match[2]}`
        : "00:00";
    }
  }
  sheet.getRange(sheet.getLastRow() + 1, 2).setNumberFormat("@");
  sheet.appendRow(["cutoffTime", "00:00"]);
  return "00:00";
}

function isCustomerOrderLocked(row) {
  const status = String(row[6] || "").trim();
  if (status === "จัดแล้ว" || status === "ยกเลิกแล้ว") return true;

  const orderDate = formatDate(row[2]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate)) return true;
  const cutoffTime = getCutoffTime();
  const now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm:ss");
  return now >= `${orderDate} ${cutoffTime}:00`;
}

function findOrderRow(orderSheet, orderId) {
  if (!orderSheet || !orderId) return -1;
  const rows = orderSheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(orderId)) return i + 1;
  }
  return -1;
}

function validateCustomerOrderItems(items, itemsSheet) {
  if (!Array.isArray(items)) return false;
  const itemRows = itemsSheet && itemsSheet.getLastRow() > 1
    ? itemsSheet.getDataRange().getValues().slice(1)
    : [];
  return items.every(item => {
    if (!item || typeof item.name !== "string" || !item.name.trim() ||
        typeof item.unit !== "string" || !item.unit.trim() ||
        !isFinite(Number(item.qty)) || Number(item.qty) <= 0) {
      return false;
    }
    const matchingRows = itemRows.filter(row => String(row[1]) === item.name);
    return matchingRows.length > 0 && matchingRows.some(row =>
      String(row[4] || "ACTIVE").trim().toUpperCase() !== "HIDDEN");
  });
}

function ensureItemStatusColumn(sheet) {
  const header = sheet.getRange(1, 5).getValue();
  if (String(header).trim().toLowerCase() !== "status") {
    sheet.getRange(1, 5).setValue("Status");
  }
}

function getOrderBillingColumns(sheet, createMissing) {
  let lastColumn = Math.max(sheet.getLastColumn(), 8);
  let headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  const columns = {};

  ["Payment", "UnitPrices", "TotalAmount"].forEach(name => {
    let index = headers.findIndex(header => String(header).trim().toLowerCase() === name.toLowerCase());
    if (index < 0 && createMissing) {
      index = lastColumn;
      lastColumn++;
      sheet.getRange(1, index + 1).setValue(name);
      headers.push(name);
    }
    columns[name] = index < 0 ? 0 : index + 1;
  });
  return columns;
}

function parseUnitPrices(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

// ==========================================
// 1. ฟังก์ชัน doGet สำหรับดึงข้อมูล (GET Request)
// ==========================================
function doGet(e) {
  const action = e.parameter.action;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  try {
    // 1.1 ดึงรายการผักและรายชื่อร้านค้าทั้งหมด
    if (action === "getInitialData") {
      const itemsSheet = ss.getSheetByName(SHEET_ITEMS);
      const shopsSheet = ss.getSheetByName(SHEET_SHOPS);
      
      let vegetables = [];
      if (itemsSheet) {
        ensureItemStatusColumn(itemsSheet);
        if (itemsSheet.getLastRow() > 1) {
          const itemRows = itemsSheet.getDataRange().getValues().slice(1);
          vegetables = itemRows.map(r => ({
            id: r[0],
            name: r[1],
            unit: r[2],
            image: r[3] || "",
            status: String(r[4] || "ACTIVE").trim().toUpperCase() === "HIDDEN" ? "HIDDEN" : "ACTIVE"
          }));
        }
      }
      
      let customers = [];
      if (shopsSheet && shopsSheet.getLastRow() > 1) {
        const shopRows = shopsSheet.getDataRange().getValues().slice(1);
        customers = shopRows.map(r => ({
          id: String(r[0]),
          name: String(r[1]),
          contact: r[2] ? String(r[2]) : ""
        }));
      }
      
      return responseJSON({
        success: true,
        vegetables: vegetables,
        customers: customers,
        cutoffTime: getCutoffTime()
      });
    }
    
    // 1.2 ดึงออเดอร์สำหรับหน้า Admin
    if (action === "getAdminOrders") {
      const targetDate = e.parameter.date;
      const orderSheet = ss.getSheetByName(SHEET_ORDERS);
      const itemsSheet = ss.getSheetByName(SHEET_ITEMS);
      
      if (!orderSheet || orderSheet.getLastRow() <= 1) {
        return responseJSON({ success: true, orders: [] });
      }
      
      let itemMap = {};
      if (itemsSheet && itemsSheet.getLastRow() > 1) {
        const itemRows = itemsSheet.getDataRange().getValues().slice(1);
        itemRows.forEach(r => {
          itemMap[r[0]] = { name: r[1], unit: r[2] };
        });
      }
      
      const rows = orderSheet.getDataRange().getValues().slice(1);
      const billingColumns = getOrderBillingColumns(orderSheet, false);
      let filtered = rows;
      if (targetDate) {
        filtered = rows.filter(r => formatDate(r[2]) === targetDate);
      }
      
      const orders = filtered.map(r => {
        let rawItems = [];
        try {
          if (r[4] && typeof r[4] === 'string' && r[4].trim().startsWith('[')) {
            rawItems = JSON.parse(r[4]);
          }
        } catch (err) {
          rawItems = [];
        }
        
        const savedPrices = parseUnitPrices(
          billingColumns.UnitPrices ? r[billingColumns.UnitPrices - 1] : ""
        );
        const priceMap = {};
        savedPrices.forEach(saved => {
          priceMap[`${saved.name}_${saved.unit}`] = saved.unitPrice;
        });
        const parsedItems = rawItems.map(it => {
          const item = it.itemId && itemMap[it.itemId]
            ? {
                name: itemMap[it.itemId].name,
                qty: it.qty,
                originalQty: it.originalQty,
                unit: itemMap[it.itemId].unit
              }
            : {
                name: it.name || it.itemId || "ไม่ระบุ",
                qty: it.qty || 1,
                originalQty: it.originalQty,
                unit: it.unit || "กก."
              };
          const priceKey = `${item.name}_${item.unit}`;
          if (Object.prototype.hasOwnProperty.call(priceMap, priceKey)) {
            item.unitPrice = priceMap[priceKey];
          }
          return item;
        });
        
        return {
          orderId: r[0] || "",
          timestamp: r[1] ? String(r[1]) : "",
          orderDate: formatDate(r[2]),
          customerName: r[3] || "",
          items: parsedItems,
          addOnNote: r[5] || "",
          status: r[6] || "รอดำเนินการ",
          notes: r[7] || "",
          paymentStatus: billingColumns.Payment ? (r[billingColumns.Payment - 1] || "ค้างชำระ") : "ค้างชำระ",
          totalAmount: billingColumns.TotalAmount ? (Number(r[billingColumns.TotalAmount - 1]) || 0) : 0,
          hasPricing: savedPrices.length > 0 && parsedItems.every(item =>
            Object.prototype.hasOwnProperty.call(item, "unitPrice"))
        };
      });
      
      return responseJSON({ success: true, orders: orders });
    }
    
    // 1.3 ดึงประวัติย้อนหลังของลูกค้าแต่ละร้าน (สำหรับ index.html)
    if (action === "getCustomerHistory") {
      const customerName = e.parameter.customerName;
      const orderSheet = ss.getSheetByName(SHEET_ORDERS);
      const itemsSheet = ss.getSheetByName(SHEET_ITEMS);
      
      if (!orderSheet || orderSheet.getLastRow() <= 1) {
        return responseJSON({ success: true, orders: [] });
      }
      
      let itemMap = {};
      if (itemsSheet && itemsSheet.getLastRow() > 1) {
        const itemRows = itemsSheet.getDataRange().getValues().slice(1);
        itemRows.forEach(r => {
          itemMap[r[0]] = { name: r[1], unit: r[2] };
        });
      }
      
      const rows = orderSheet.getDataRange().getValues().slice(1);
      const billingColumns = getOrderBillingColumns(orderSheet, false);
      const customerOrders = rows
        .filter(r => String(r[3]).trim() === String(customerName).trim())
        .reverse()
        .slice(0, 30)
        .map(r => {
          let rawItems = [];
          try {
            if (r[4] && typeof r[4] === 'string' && r[4].trim().startsWith('[')) {
              rawItems = JSON.parse(r[4]);
            }
          } catch (err) {
            rawItems = [];
          }

          const savedPrices = parseUnitPrices(
            billingColumns.UnitPrices ? r[billingColumns.UnitPrices - 1] : ""
          );
          const priceMap = {};
          savedPrices.forEach(saved => {
            priceMap[`${saved.name}_${saved.unit}`] = saved.unitPrice;
          });
          
          const parsedItems = rawItems.map(it => {
            const item = it.itemId && itemMap[it.itemId]
              ? {
                name: itemMap[it.itemId].name,
                qty: it.qty,
                originalQty: it.originalQty,
                unit: itemMap[it.itemId].unit
              }
              : {
                name: it.name || it.itemId || "ไม่ระบุ",
                qty: it.qty || 1,
                originalQty: it.originalQty,
                unit: it.unit || "กก."
              };
            const priceKey = `${item.name}_${item.unit}`;
            if (Object.prototype.hasOwnProperty.call(priceMap, priceKey)) {
              item.unitPrice = priceMap[priceKey];
            }
            return item;
          });
          
          return {
            orderId: r[0] || "",
            timestamp: r[1] ? String(r[1]) : "",
            orderDate: formatDate(r[2]),
            items: parsedItems,
            addOnNote: r[5] || "",
            status: r[6] || "รอดำเนินการ",
            notes: r[7] || "",
            paymentStatus: billingColumns.Payment ? (r[billingColumns.Payment - 1] || "ค้างชำระ") : "ค้างชำระ",
            totalAmount: billingColumns.TotalAmount ? (Number(r[billingColumns.TotalAmount - 1]) || 0) : 0,
            hasPricing: savedPrices.length > 0 && parsedItems.every(item =>
              Object.prototype.hasOwnProperty.call(item, "unitPrice"))
          };
        });
        
      return responseJSON({ success: true, orders: customerOrders });
    }
    
    return responseJSON({ success: false, message: "Invalid action" });
  } catch (err) {
    return responseJSON({ success: false, error: err.toString() });
  }
}

// ==========================================
// 2. ฟังก์ชัน doPost สำหรับบันทึก/แก้ไขข้อมูล (POST Request)
// ==========================================
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const orderSheet = ss.getSheetByName(SHEET_ORDERS);
    const itemsSheet = ss.getSheetByName(SHEET_ITEMS);
    const shopsSheet = ss.getSheetByName(SHEET_SHOPS);
    
    // 2.1 สั่งออเดอร์ใหม่จากลูกค้า (index.html)
    if (data.action === "createOrder") {
      if (!Array.isArray(data.items)) {
        return responseJSON({ success: false, message: "Invalid order items" });
      }
      const itemRows = itemsSheet.getDataRange().getValues();
      const unavailableItems = data.items.filter(item => {
        const matchingRows = itemRows.slice(1).filter(row => String(row[1]) === String(item.name));
        return matchingRows.length > 0 && matchingRows.every(row =>
          String(row[4] || "ACTIVE").trim().toUpperCase() === "HIDDEN");
      });
      if (unavailableItems.length) {
        return responseJSON({ success: false, message: "One or more items are currently unavailable" });
      }
      const orderId = "ORD-" + Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyyMMdd-HHmmss");
      const timestamp = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm:ss");
      const orderDate = data.orderDate;
      const shopName = data.customerName;
      const itemsJSON = JSON.stringify(data.items);
      const addOns = data.addOnNote || "";
      const status = "รอดำเนินการ";
      const notes = "";
      
      const billingColumns = getOrderBillingColumns(orderSheet, true);
      const newRow = [
        orderId,
        timestamp,
        orderDate,
        shopName,
        itemsJSON,
        addOns,
        status,
        notes
      ];
      while (newRow.length < Math.max(billingColumns.Payment, billingColumns.UnitPrices, billingColumns.TotalAmount)) {
        newRow.push("");
      }
      newRow[billingColumns.Payment - 1] = "ค้างชำระ";
      orderSheet.appendRow(newRow);
      
      return responseJSON({ success: true, orderId: orderId });
    }

    if (data.action === "cancelOrder" || data.action === "updateCustomerOrder") {
      const orderId = String(data.orderId || "").trim();
      const rowNumber = findOrderRow(orderSheet, orderId);
      if (rowNumber < 0) {
        return responseJSON({ success: false, message: "Order not found" });
      }

      const row = orderSheet.getRange(rowNumber, 1, 1, Math.max(orderSheet.getLastColumn(), 8)).getValues()[0];
      if (data.action === "cancelOrder" && !data.customerName) {
        orderSheet.getRange(rowNumber, 7).setValue("ยกเลิกแล้ว");
        return responseJSON({ success: true, orderId: orderId });
      }
      if (!data.customerName || String(row[3]).trim() !== String(data.customerName).trim()) {
        return responseJSON({ success: false, message: "Order does not belong to this customer" });
      }
      if (isCustomerOrderLocked(row)) {
        return responseJSON({ success: false, message: "หมดเวลาแก้ไข/ยกเลิกสำหรับรอบนี้แล้ว กรุณาโทรติดต่อแม่ทิพย์โดยตรง" });
      }

      if (data.action === "cancelOrder") {
        orderSheet.getRange(rowNumber, 7).setValue("ยกเลิกแล้ว");
        return responseJSON({ success: true, orderId: orderId });
      }

      if (!validateCustomerOrderItems(data.items, itemsSheet) ||
          (data.addOnNote !== undefined && typeof data.addOnNote !== "string")) {
        return responseJSON({ success: false, message: "Invalid order items" });
      }
      const addOnNote = data.addOnNote === undefined ? row[5] : data.addOnNote;
      if (data.items.length === 0 && !String(addOnNote || "").trim()) {
        return responseJSON({ success: false, message: "Order must contain items or an add-on note" });
      }
      orderSheet.getRange(rowNumber, 5, 1, 2).setValues([[
        JSON.stringify(data.items.map(item => ({
          name: item.name.trim(),
          qty: Number(item.qty),
          unit: item.unit.trim()
        }))),
        addOnNote || ""
      ]]);
      const billingColumns = getOrderBillingColumns(orderSheet, false);
      if (billingColumns.UnitPrices) orderSheet.getRange(rowNumber, billingColumns.UnitPrices).clearContent();
      if (billingColumns.TotalAmount) orderSheet.getRange(rowNumber, billingColumns.TotalAmount).clearContent();
      if (billingColumns.Payment) orderSheet.getRange(rowNumber, billingColumns.Payment).setValue("ค้างชำระ");
      return responseJSON({ success: true, orderId: orderId });
    }

    if (data.action === "updateCutoffTime") {
      const cutoffTime = String(data.cutoffTime || "").trim();
      const match = cutoffTime.match(/^(\d{2}):(\d{2})$/);
      if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
        return responseJSON({ success: false, message: "Invalid cutoff time" });
      }
      const settingsSheet = getSettingsSheet();
      const rows = settingsSheet.getDataRange().getValues();
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][0]).trim() === "cutoffTime") {
          settingsSheet.getRange(i + 1, 2).setNumberFormat("@");
          settingsSheet.getRange(i + 1, 2).setValue(cutoffTime);
          return responseJSON({ success: true, cutoffTime: cutoffTime });
        }
      }
      settingsSheet.getRange(settingsSheet.getLastRow() + 1, 2).setNumberFormat("@");
      settingsSheet.appendRow(["cutoffTime", cutoffTime]);
      return responseJSON({ success: true, cutoffTime: cutoffTime });
    }
    
    // 2.2 อัปเดตสถานะออเดอร์โดยรวม (admin.html)
    if (data.action === "updateStatus") {
      const orderId = data.orderId;
      const newStatus = data.status;
      const rows = orderSheet.getDataRange().getValues();
      
      for (let i = 1; i < rows.length; i++) {
        if (rows[i][0] === orderId) {
          orderSheet.getRange(i + 1, 7).setValue(newStatus);
          return responseJSON({ success: true });
        }
      }
      return responseJSON({ success: false, message: "Order not found" });
    }

    // 2.3 ปรับแก้จำนวนผักกรณีของไม่พอ (admin.html)
    if (data.action === "updateOrderItems") {
      const orderId = data.orderId;
      const updatedItems = data.items;
      const rows = orderSheet.getDataRange().getValues();
      
      for (let i = 1; i < rows.length; i++) {
        if (rows[i][0] === orderId) {
          orderSheet.getRange(i + 1, 5).setValue(JSON.stringify(updatedItems));
          const billingColumns = getOrderBillingColumns(orderSheet, false);
          if (billingColumns.UnitPrices) orderSheet.getRange(i + 1, billingColumns.UnitPrices).clearContent();
          if (billingColumns.TotalAmount) orderSheet.getRange(i + 1, billingColumns.TotalAmount).clearContent();
          return responseJSON({ success: true });
        }
      }
      return responseJSON({ success: false, message: "Order not found" });
    }

    // บันทึกราคาต่อหน่วยและยอดรวมของออเดอร์ (admin.html)
    if (data.action === "updateOrderPricing") {
      if (!data.orderId || !Array.isArray(data.items)) {
        return responseJSON({ success: false, message: "Invalid pricing data" });
      }
      const pricedItems = [];
      let totalAmount = 0;
      for (const item of data.items) {
        const qty = Number(item.qty);
        const unitPrice = Number(item.unitPrice);
        if (!isFinite(qty) || qty < 0 || !isFinite(unitPrice) || unitPrice < 0) {
          return responseJSON({ success: false, message: "Invalid quantity or unit price" });
        }
        const lineTotal = qty * unitPrice;
        totalAmount += lineTotal;
        pricedItems.push({
          name: String(item.name || ""),
          unit: String(item.unit || ""),
          qty: qty,
          unitPrice: unitPrice,
          lineTotal: lineTotal
        });
      }
      const rows = orderSheet.getDataRange().getValues();
      const billingColumns = getOrderBillingColumns(orderSheet, true);
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][0]) === String(data.orderId)) {
          orderSheet.getRange(i + 1, billingColumns.UnitPrices).setValue(JSON.stringify(pricedItems));
          orderSheet.getRange(i + 1, billingColumns.TotalAmount).setValue(totalAmount);
          return responseJSON({ success: true, totalAmount: totalAmount });
        }
      }
      return responseJSON({ success: false, message: "Order not found" });
    }

    // อัปเดตสถานะชำระเงินของออเดอร์ (admin.html)
    if (data.action === "updatePaymentStatus") {
      const allowedStatuses = ["ชำระแล้ว", "ค้างชำระ"];
      if (!data.orderId || allowedStatuses.indexOf(data.paymentStatus) < 0) {
        return responseJSON({ success: false, message: "Invalid payment status" });
      }
      const rows = orderSheet.getDataRange().getValues();
      const billingColumns = getOrderBillingColumns(orderSheet, true);
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][0]) === String(data.orderId)) {
          orderSheet.getRange(i + 1, billingColumns.Payment).setValue(data.paymentStatus);
          return responseJSON({ success: true, paymentStatus: data.paymentStatus });
        }
      }
      return responseJSON({ success: false, message: "Order not found" });
    }

    // 2.4 เพิ่มสินค้าผักใหม่พร้อมอัปโหลดรูปภาพ WebP เข้า Google Drive (admin.html)
    if (data.action === "addNewItem") {
      ensureItemStatusColumn(itemsSheet);
      const itemName = data.name;
      const unit = data.unit || "กก.";
      const base64Image = data.base64Image;
      
      let imageUrl = "";
      if (base64Image) {
        const folder = DriveApp.getFolderById(DRIVE_IMAGE_FOLDER_ID);
        const decoded = Utilities.base64Decode(base64Image);
        const blob = Utilities.newBlob(decoded, "image/webp", `${Date.now()}_${itemName}.webp`);
        const file = folder.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        imageUrl = `https://lh3.googleusercontent.com/d/${file.getId()}`;
      }

      const lastRow = itemsSheet.getLastRow();
      const existingIds = lastRow > 1
        ? itemsSheet.getRange(2, 1, lastRow - 1, 1).getValues()
        : [];
      const highestId = existingIds.reduce((highest, row) => {
        const match = String(row[0]).match(/^ITM-(\d+)$/);
        return match ? Math.max(highest, Number(match[1])) : highest;
      }, 0);
      const newId = "ITM-" + String(highestId + 1).padStart(3, '0');
      itemsSheet.appendRow([newId, itemName, unit, imageUrl, "ACTIVE"]);

      return responseJSON({ success: true, itemId: newId, imageUrl: imageUrl });
    }

    // สลับการแสดงสินค้าในหน้าสั่งซื้อ
    if (data.action === "toggleItemStatus") {
      const itemId = data.itemId;
      const status = data.status;
      if (itemId === undefined || itemId === null || String(itemId).trim() === "" ||
          ["ACTIVE", "HIDDEN"].indexOf(status) < 0) {
        return responseJSON({ success: false, message: "Invalid item status data" });
      }
      ensureItemStatusColumn(itemsSheet);
      const rows = itemsSheet.getDataRange().getValues();

      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][0]) === String(itemId)) {
          itemsSheet.getRange(i + 1, 5).setValue(status);
          return responseJSON({ success: true, status: status });
        }
      }
      return responseJSON({ success: false, message: "Item not found" });
    }

    // แก้ไขข้อมูลผัก/สินค้า (ชื่อผัก, หน่วยนับ)
    if (data.action === "updateItem") {
      const itemId = data.itemId;
      const newName = data.name;
      const newUnit = data.unit;
      if (itemId === undefined || itemId === null || String(itemId).trim() === "" ||
          typeof newName !== "string" || !newName.trim() ||
          typeof newUnit !== "string" || !newUnit.trim()) {
        return responseJSON({ success: false, message: "Invalid item data" });
      }
      const rows = itemsSheet.getDataRange().getValues();

      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][0]) === String(itemId)) {
          itemsSheet.getRange(i + 1, 2).setValue(newName.trim());
          itemsSheet.getRange(i + 1, 3).setValue(newUnit.trim());
          return responseJSON({ success: true });
        }
      }
      return responseJSON({ success: false, message: "Item not found" });
    }

    // ลบสินค้าออกจากชีต Items
    if (data.action === "deleteItem") {
      const itemId = data.itemId;
      if (itemId === undefined || itemId === null || String(itemId).trim() === "") {
        return responseJSON({ success: false, message: "Invalid item ID" });
      }
      const rows = itemsSheet.getDataRange().getValues();

      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][0]) === String(itemId)) {
          itemsSheet.deleteRow(i + 1);
          return responseJSON({ success: true });
        }
      }
      return responseJSON({ success: false, message: "Item not found" });
    }

    // 2.5 ลงทะเบียนร้านค้าใหม่พร้อมรหัส ID ภาษาอังกฤษ (admin.html)
    if (data.action === "registerShop") {
      const shopId = String(data.shopId || "").trim();
      const shopName = String(data.shopName || "").trim();
      const rawContact = data.contact ? String(data.contact).trim() : "";
      const contact = rawContact ? "'" + rawContact : "";
      if (!shopId || !shopName) {
        return responseJSON({ success: false, message: "Shop ID and shop name are required" });
      }
      if (!shopsSheet) {
        return responseJSON({ success: false, message: "Shops sheet not found" });
      }

      const rows = shopsSheet.getDataRange().getValues();
      if (rows.slice(1).some(row => String(row[0]) === shopId)) {
        return responseJSON({ success: false, message: "Shop ID already exists" });
      }

      shopsSheet.appendRow([shopId, shopName, contact]);
      return responseJSON({ success: true, shopId: shopId });
    }

    // 2.6 แก้ไขชื่อร้านค้าและเบอร์โทร (admin.html)
    if (data.action === "updateShop") {
      const shopId = data.shopId;
      const newName = data.shopName;
      const newContact = data.contact || "";
      const rows = shopsSheet.getDataRange().getValues();

      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][0]) === String(shopId)) {
          shopsSheet.getRange(i + 1, 2).setValue(newName);
          shopsSheet.getRange(i + 1, 3).setValue(newContact);
          return responseJSON({ success: true });
        }
      }
      return responseJSON({ success: false, message: "Shop not found" });
    }

    // 2.7 ลบร้านค้าออกจากระบบ (admin.html)
    if (data.action === "deleteShop") {
      const shopId = data.shopId;
      const rows = shopsSheet.getDataRange().getValues();

      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][0]) === String(shopId)) {
          shopsSheet.deleteRow(i + 1);
          return responseJSON({ success: true });
        }
      }
      return responseJSON({ success: false, message: "Shop not found" });
    }
    
    return responseJSON({ success: false, message: "Invalid action" });
  } catch (err) {
    return responseJSON({ success: false, error: err.toString() });
  }
}

// ==========================================
// 3. ฟังก์ชัน Helper จัดรูปแบบข้อมูล
// ==========================================
function formatDate(d) {
  if (!d) return "";
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return String(d).trim();
    return Utilities.formatDate(dt, "Asia/Bangkok", "yyyy-MM-dd");
  } catch (err) {
    return String(d).trim();
  }
}

function responseJSON(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}