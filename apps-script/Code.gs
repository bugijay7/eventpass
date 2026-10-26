const HEADERS = [
  "Booking ID",
  "Full Name",
  "Event Name",
  "Ticket Price (KES)",
  "Customer Phone",
  "Merchant Request ID",
  "Checkout Request ID",
  "M-Pesa Receipt",
  "Booking Date and Time",
  "Payment Status",
  "Payment Result",
  "Status Token",
];

const STATUS = {
  PENDING: "Pending Verification",
  PAID: "Paid",
  REJECTED: "Rejected",
};

function doPost(e) {
  try {
    const data = parseJson_(e && e.postData && e.postData.contents);

    if (data.Body && data.Body.stkCallback) {
      return handleDarajaCallback_(e, data);
    }
    if (data.action === "status") {
      return getBookingStatus_(data);
    }
    if (data.action === "initiate") {
      return initiatePayment_(data);
    }

    throw new Error("Unsupported request.");
  } catch (error) {
    console.error(error);
    return jsonResponse_({
      success: false,
      message: error.message || "Unable to process the request.",
    });
  }
}

function initiatePayment_(data) {
  const bookingId = cleanText_(data.bookingId, 80);
  const statusToken = cleanText_(data.statusToken, 100);
  const fullName = cleanText_(data.fullName, 120);
  const phoneNumber = normalizePhone_(data.phoneNumber);
  const settings = getSettings_();
  if (!/^[\w-]{36}$/.test(bookingId) || statusToken.length < 32) {
    throw new Error("Invalid booking reference.");
  }
  if (!fullName || !phoneNumber) {
    throw new Error("Full name and a valid Kenyan mobile number are required.");
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getBookingsSheet_();
    const existingRow = findRowByValue_(sheet, 1, bookingId);
    if (existingRow) {
      if (sheet.getRange(existingRow, 12).getValue() !== statusToken) {
        throw new Error("Booking reference has already been used.");
      }
      if (sheet.getRange(existingRow, 10).getDisplayValue() !== STATUS.PENDING) {
        throw new Error("This payment request is no longer pending.");
      }
      return jsonResponse_({
        success: true,
        bookingId: bookingId,
        statusToken: statusToken,
        message: "Payment request is already being processed.",
      });
    }

    const cache = CacheService.getScriptCache();
    const rateKey = "stk_" + phoneNumber;
    if (cache.get(rateKey)) {
      throw new Error(
        "A payment prompt was recently sent to this number. Wait a minute before trying again.",
      );
    }
    const minuteKey =
      "stk_global_" +
      Utilities.formatDate(new Date(), "UTC", "yyyyMMddHHmm");
    const promptCount = Number(cache.get(minuteKey) || 0);
    if (promptCount >= 30) {
      throw new Error(
        "Too many payment requests are in progress. Please try again in a minute.",
      );
    }

    const row = sheet.getLastRow() + 1;
    sheet.appendRow([
      bookingId,
      escapeSheetText_(fullName),
      escapeSheetText_(settings.eventName),
      settings.amount,
      phoneNumber,
      "",
      "",
      "",
      new Date(),
      STATUS.PENDING,
      "Waiting for M-Pesa payment.",
      statusToken,
    ]);
    cache.put(rateKey, bookingId, 60);
    cache.put(minuteKey, String(promptCount + 1), 60);

    try {
      const result = sendStkPush_(settings, phoneNumber);
      if (String(result.ResponseCode) !== "0" || !result.CheckoutRequestID) {
        const reason = cleanText_(
          result.errorMessage || result.ResponseDescription || "M-Pesa rejected the payment request.",
          240,
        );
        sheet.getRange(row, 10, 1, 2).setValues([[STATUS.REJECTED, reason]]);
        return jsonResponse_({ success: false, message: reason });
      }

      sheet
        .getRange(row, 6, 1, 2)
        .setValues([[result.MerchantRequestID || "", result.CheckoutRequestID]]);
      return jsonResponse_({
        success: true,
        bookingId: bookingId,
        statusToken: statusToken,
        message: "Payment prompt sent. Approve it on your phone.",
      });
    } catch (error) {
      console.error(error);
      sheet
        .getRange(row, 11)
        .setValue(
          "Payment request outcome is unknown. Check the phone before retrying.",
        );
      return jsonResponse_({
        success: false,
        bookingId: bookingId,
        statusToken: statusToken,
        message:
          "We could not confirm whether the payment prompt was sent. Check your phone before trying again.",
      });
    }
  } finally {
    if (lock.hasLock()) {
      lock.releaseLock();
    }
  }
}

function sendStkPush_(settings, phoneNumber) {
  const baseUrl =
    settings.environment === "production"
      ? "https://api.safaricom.co.ke"
      : "https://sandbox.safaricom.co.ke";
  const authorization = "Basic " +
    Utilities.base64Encode(settings.consumerKey + ":" + settings.consumerSecret);

  const tokenResponse = UrlFetchApp.fetch(
    baseUrl + "/oauth/v1/generate?grant_type=client_credentials",
    {
      method: "get",
      headers: { Authorization: authorization },
      muteHttpExceptions: true,
    },
  );
  const tokenBody = parseApiResponse_(tokenResponse, "M-Pesa authentication");
  if (!tokenBody.access_token) {
    throw new Error("M-Pesa authentication did not return an access token.");
  }

  const timestamp = Utilities.formatDate(
    new Date(),
    "Africa/Nairobi",
    "yyyyMMddHHmmss",
  );
  const password = Utilities.base64Encode(
    settings.shortcode + settings.passkey + timestamp,
  );
  const callbackToken = settings.callbackToken;
  const callbackUrl =
    ScriptApp.getService().getUrl() +
    "?callbackToken=" +
    encodeURIComponent(callbackToken);

  const payload = {
    BusinessShortCode: settings.shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: settings.transactionType,
    Amount: settings.amount,
    PartyA: phoneNumber,
    PartyB: settings.shortcode,
    PhoneNumber: phoneNumber,
    CallBackURL: callbackUrl,
    AccountReference: settings.accountReference,
    TransactionDesc: settings.transactionDescription,
  };

  const response = UrlFetchApp.fetch(
    baseUrl + "/mpesa/stkpush/v1/processrequest",
    {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + tokenBody.access_token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    },
  );
  return parseApiResponse_(response, "M-Pesa payment request");
}

function handleDarajaCallback_(e, data) {
  const settings = getSettings_();
  const callbackToken = e && e.parameter && e.parameter.callbackToken;
  if (!callbackToken || callbackToken !== settings.callbackToken) {
    throw new Error("Unauthorized payment callback.");
  }

  const callback = data.Body.stkCallback;
  const checkoutId = cleanText_(callback.CheckoutRequestID, 100);
  if (!checkoutId) {
    throw new Error("Payment callback is missing its checkout ID.");
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getBookingsSheet_();
    const row = findRowByValue_(sheet, 7, checkoutId);
    if (!row) {
      throw new Error("No booking matches the payment callback.");
    }
    if (sheet.getRange(row, 10).getDisplayValue() !== STATUS.PENDING) {
      return jsonResponse_({ success: true, message: "Callback already processed." });
    }

    const resultCode = Number(callback.ResultCode);
    if (resultCode !== 0) {
      const reason = cleanText_(
        callback.ResultDesc || "M-Pesa payment was not completed.",
        240,
      );
      sheet.getRange(row, 10, 1, 2).setValues([[STATUS.REJECTED, reason]]);
      return jsonResponse_({ success: true });
    }

    const metadata = callbackMetadata_(callback.CallbackMetadata);
    const expectedAmount = Number(sheet.getRange(row, 4).getValue());
    const expectedPhone = sheet.getRange(row, 5).getDisplayValue();
    const receipt = cleanText_(metadata.MpesaReceiptNumber, 32).toUpperCase();
    const paidPhone = normalizePhone_(String(metadata.PhoneNumber || ""));
    const amountMatches = Number(metadata.Amount) === expectedAmount;
    const phoneMatches = paidPhone === expectedPhone;

    if (!receipt || !amountMatches || !phoneMatches) {
      const reason = !receipt
        ? "M-Pesa callback did not include a receipt number."
        : !amountMatches
          ? "The confirmed payment amount did not match the ticket price."
          : "The confirmed payment phone number did not match this booking.";
      sheet.getRange(row, 10, 1, 2).setValues([[STATUS.REJECTED, reason]]);
      return jsonResponse_({ success: true });
    }
    if (findRowByValue_(sheet, 8, receipt)) {
      sheet
        .getRange(row, 10, 1, 2)
        .setValues([[STATUS.REJECTED, "M-Pesa receipt was already used."]]);
      return jsonResponse_({ success: true });
    }

    sheet
      .getRange(row, 8, 1, 4)
      .setValues([
        [
          receipt,
          sheet.getRange(row, 9).getValue(),
          STATUS.PAID,
          "Payment confirmed by M-Pesa.",
        ],
      ]);
    return jsonResponse_({ success: true });
  } finally {
    if (lock.hasLock()) {
      lock.releaseLock();
    }
  }
}

function getBookingStatus_(data) {
  const bookingId = cleanText_(data.bookingId, 80);
  const statusToken = cleanText_(data.statusToken, 100);
  if (!bookingId || !statusToken) {
    throw new Error("Booking status credentials are required.");
  }

  const sheet = getBookingsSheet_();
  const row = findRowByValue_(sheet, 1, bookingId);
  if (!row || sheet.getRange(row, 12).getValue() !== statusToken) {
    throw new Error("Booking not found.");
  }
  return jsonResponse_({
    success: true,
    paymentStatus: sheet.getRange(row, 10).getDisplayValue(),
    paymentResult: sheet.getRange(row, 11).getDisplayValue(),
  });
}

function getSettings_() {
  const properties = PropertiesService.getScriptProperties();
  const values = properties.getProperties();
  const required = [
    "SPREADSHEET_ID",
    "DARAJA_CONSUMER_KEY",
    "DARAJA_CONSUMER_SECRET",
    "DARAJA_SHORTCODE",
    "DARAJA_PASSKEY",
    "DARAJA_CALLBACK_TOKEN",
    "DARAJA_ENV",
    "DARAJA_TRANSACTION_TYPE",
    "EVENT_NAME",
    "TICKET_PRICE_KES",
    "ACCOUNT_REFERENCE",
  ];
  const missing = required.filter(function (key) {
    return !values[key];
  });
  if (missing.length) {
    throw new Error("Payment service is not configured: " + missing.join(", "));
  }

  const environment = values.DARAJA_ENV.toLowerCase();
  const transactionType = values.DARAJA_TRANSACTION_TYPE;
  const shortcode = values.DARAJA_SHORTCODE;
  const amount = Number(values.TICKET_PRICE_KES);
  if (!["sandbox", "production"].includes(environment)) {
    throw new Error("DARAJA_ENV must be sandbox or production.");
  }
  if (!/^\d{5,7}$/.test(shortcode)) {
    throw new Error("DARAJA_SHORTCODE must be the Paybill or Till shortcode.");
  }
  if (
    !["CustomerPayBillOnline", "CustomerBuyGoodsOnline"].includes(
      transactionType,
    )
  ) {
    throw new Error(
      "DARAJA_TRANSACTION_TYPE must match the registered Paybill or Till.",
    );
  }
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("TICKET_PRICE_KES must be a positive whole number.");
  }
  if (values.DARAJA_CALLBACK_TOKEN.length < 32) {
    throw new Error("DARAJA_CALLBACK_TOKEN must be at least 32 characters.");
  }

  return {
    environment: environment,
    consumerKey: values.DARAJA_CONSUMER_KEY,
    consumerSecret: values.DARAJA_CONSUMER_SECRET,
    shortcode: shortcode,
    passkey: values.DARAJA_PASSKEY,
    callbackToken: values.DARAJA_CALLBACK_TOKEN,
    transactionType: transactionType,
    eventName: values.EVENT_NAME,
    amount: amount,
    accountReference: values.ACCOUNT_REFERENCE.slice(0, 12),
    transactionDescription: ("Ticket: " + values.EVENT_NAME).slice(0, 30),
  };
}

function parseJson_(contents) {
  if (!contents) {
    throw new Error("Request details are required.");
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error("Request details must be valid JSON.");
  }
}

function parseApiResponse_(response, serviceName) {
  const code = response.getResponseCode();
  let body;
  try {
    body = JSON.parse(response.getContentText());
  } catch (error) {
    throw new Error(serviceName + " returned an invalid response.");
  }
  if (code < 200 || code >= 300) {
    throw new Error(
      body.errorMessage ||
        body.error_description ||
        serviceName + " failed (HTTP " + code + ").",
    );
  }
  return body;
}

function callbackMetadata_(metadata) {
  const values = {};
  const items = metadata && metadata.Item;
  if (Array.isArray(items)) {
    items.forEach(function (item) {
      if (item && item.Name) {
        values[item.Name] = item.Value;
      }
    });
  }
  return values;
}

function normalizePhone_(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (/^0[17]\d{8}$/.test(digits)) return "254" + digits.slice(1);
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  if (/^[17]\d{8}$/.test(digits)) return "254" + digits;
  return "";
}

function cleanText_(value, maxLength) {
  if (typeof value !== "string" && typeof value !== "number") {
    return "";
  }
  return String(value).trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function escapeSheetText_(value) {
  return /^[=+\-@]/.test(value) ? "'" + value : value;
}

function getBookingsSheet_() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty(
    "SPREADSHEET_ID",
  );
  if (!spreadsheetId) {
    throw new Error("SPREADSHEET_ID has not been configured.");
  }

  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  let sheet = spreadsheet.getSheetByName("STK Bookings");
  if (!sheet) {
    sheet = spreadsheet.insertSheet("STK Bookings");
  }

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  } else {
    const existingHeaders = sheet
      .getRange(1, 1, 1, HEADERS.length)
      .getDisplayValues()[0];
    const headersMatch = HEADERS.every(function (header, index) {
      return existingHeaders[index] === header;
    });
    if (!headersMatch) {
      throw new Error(
        'The "STK Bookings" sheet has unexpected headers. Create a new empty "STK Bookings" tab for the STK Push version.',
      );
    }
  }
  return sheet;
}

function findRowByValue_(sheet, column, value) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const values = sheet.getRange(2, column, lastRow - 1, 1).getDisplayValues();
  for (let index = 0; index < values.length; index += 1) {
    if (String(values[index][0]).trim() === String(value)) {
      return index + 2;
    }
  }
  return 0;
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
