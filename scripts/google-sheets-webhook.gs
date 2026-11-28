function doPost(e) {
  try {
    var rawBody = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    var record = JSON.parse(rawBody);
    var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = spreadsheet.getSheetByName('Leads');

    if (!sheet) {
      sheet = spreadsheet.insertSheet('Leads');
      sheet.appendRow([
        'Created At',
        'Lead ID',
        'Lead Type',
        'Name',
        'Phone',
        'Email',
        'Postal Code',
        'Area',
        'Service',
        'Pre-Tax CAD',
        'Preferred Date',
        'Slot Window',
        'UTM Source',
        'UTM Campaign',
        'Notes',
      ]);
    }

    sheet.appendRow([
      record.createdAt || new Date().toISOString(),
      record.leadId || '',
      record.leadType || 'residential_quote',
      record.name || '',
      record.phone || '',
      record.email || '',
      record.postalCode || '',
      record.areaName || '',
      record.serviceTitle || '',
      record.finalPreTaxCad || 0,
      record.preferredDate || (record.preferredSlot ? record.preferredSlot.date : ''),
      record.preferredSlot ? record.preferredSlot.window : '',
      record.utmSource || '',
      record.utmCampaign || '',
      record.notes || '',
    ]);

    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(
      ContentService.MimeType.JSON,
    );
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: String(err) }),
    ).setMimeType(ContentService.MimeType.JSON);
  }
}
