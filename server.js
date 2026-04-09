const express = require('express');
const { PDFDocument, StandardFonts, rgb, PDFName, PDFString } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

// Load templates at startup
const lagTemplate = fs.readFileSync(path.join(__dirname, 'templates', 'lag_template.pdf'));
const approvdTemplate = fs.readFileSync(path.join(__dirname, 'templates', 'approvd_template.pdf'));

console.log(`LAG template: ${lagTemplate.length} bytes`);
console.log(`Approvd template: ${approvdTemplate.length} bytes`);

/**
 * POST /fill-pdf
 * Body: { template: "lag" | "approvd", fields: { fieldName: value, ... }, signatures: { fieldName: "Owner Name", ... } }
 * Returns: { pdf: "<base64 encoded PDF>" }
 */
app.post('/fill-pdf', async (req, res) => {
    try {
        const { template, fields, signatures } = req.body;

        if (!template || !fields) {
            return res.status(400).json({ error: 'Missing template or fields' });
        }

        let templateBytes;
        if (template === 'lag') {
            templateBytes = lagTemplate;
        } else if (template === 'approvd') {
            templateBytes = approvdTemplate;
        } else {
            return res.status(400).json({ error: `Unknown template: ${template}` });
        }

        // Load the PDF
        const pdfDoc = await PDFDocument.load(templateBytes, { ignoreEncryption: true });
        const form = pdfDoc.getForm();
        const page = pdfDoc.getPages()[0];

        // Embed fonts
        const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const italicFont = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

        // Get all form fields
        const allFields = form.getFields();
        console.log(`Template "${template}" has ${allFields.length} fields`);

        let filledCount = 0;

        // Signature field names (these get italic/cursive font)
        const signatureFieldNames = new Set([
            'signature_43ttvl', 'signature_44bgvq',           // LAG signature widgets
            'Owner Signature 1', 'Owner Signature 2',          // Approvd signature text fields
        ]);

        // Fill text fields by drawing directly on the page (bypasses form rendering issues)
        for (const [fieldName, value] of Object.entries(fields)) {
            if (!value || value.trim() === '') continue;
            // Skip LAG signature widget fields (handled separately below)
            if (fieldName.startsWith('signature_')) continue;

            try {
                const field = form.getTextField(fieldName);
                const widgets = field.acroField.getWidgets();
                if (widgets.length === 0) continue;

                const rect = widgets[0].getRectangle();
                const isSignatureField = signatureFieldNames.has(fieldName);

                // Determine font size based on field height and DA string
                let fontSize = 0;
                // Check the DA string for the field's intended font size
                const daStr = field.acroField.getDefaultAppearance();
                if (daStr) {
                    const sizeMatch = daStr.match(/(\d+(?:\.\d+)?)\s+Tf/);
                    if (sizeMatch) {
                        fontSize = parseFloat(sizeMatch[1]);
                    }
                }

                // If font size is 0 (auto) or unreasonable, calculate from field height
                if (fontSize <= 0 || fontSize > rect.height) {
                    fontSize = Math.min(10, Math.max(6, rect.height * 0.65));
                }

                // Scale down if text is too long for the field
                let textWidth = helvetica.widthOfTextAtSize(value, fontSize);
                const maxWidth = rect.width - 6;
                if (textWidth > maxWidth && maxWidth > 0) {
                    fontSize = fontSize * (maxWidth / textWidth);
                    fontSize = Math.max(5, fontSize); // minimum 5pt
                }

                // Choose font: italic for signature fields, regular for others
                const useFont = isSignatureField ? italicFont : helvetica;
                const fontColor = isSignatureField ? rgb(0.05, 0.05, 0.15) : rgb(0, 0, 0);

                // For signature fields, use slightly larger font if possible
                if (isSignatureField) {
                    fontSize = Math.min(12, Math.max(8, rect.height * 0.7));
                    // Re-check width
                    let sigWidth = useFont.widthOfTextAtSize(value, fontSize);
                    if (sigWidth > rect.width - 6) {
                        fontSize = fontSize * ((rect.width - 6) / sigWidth);
                        fontSize = Math.max(6, fontSize);
                    }
                }

                // Draw text on the page at the field's position
                page.drawText(value, {
                    x: rect.x + 3,
                    y: rect.y + (rect.height - fontSize) / 2 + 1,
                    size: fontSize,
                    font: useFont,
                    color: fontColor,
                });

                filledCount++;
            } catch (err) {
                console.warn(`Field "${fieldName}": ${err.message}`);
            }
        }

        // Handle signature fields
        const sigs = signatures || {};
        for (const [fieldName, sigName] of Object.entries(sigs)) {
            if (!sigName || sigName.trim() === '') continue;

            try {
                const field = form.getField(fieldName);
                if (!field) continue;

                const widgets = field.acroField.getWidgets();
                if (widgets.length === 0) continue;

                const rect = widgets[0].getRectangle();
                const fontSize = Math.min(16, Math.max(8, rect.height * 0.6));

                // Draw signature in italic font
                page.drawText(sigName, {
                    x: rect.x + 4,
                    y: rect.y + (rect.height - fontSize) / 2 + 2,
                    size: fontSize,
                    font: italicFont,
                    color: rgb(0.05, 0.05, 0.15),
                });
                filledCount++;
            } catch (err) {
                console.warn(`Signature "${fieldName}": ${err.message}`);
            }
        }

        // Remove all form fields (flatten by removing) so we're left with just the drawn text
        // This avoids the "Could not find page" error with form.flatten()
        const fieldsCopy = [...form.getFields()];
        for (const field of fieldsCopy) {
            try {
                form.removeField(field);
            } catch (err) {
                // Some fields may fail to remove, that's ok
            }
        }

        const pdfBytes = await pdfDoc.save();
        const base64Pdf = Buffer.from(pdfBytes).toString('base64');

        console.log(`Filled ${filledCount} fields for template "${template}"`);

        res.json({
            success: true,
            filledFields: filledCount,
            pdf: base64Pdf
        });

    } catch (err) {
        console.error('Error filling PDF:', err);
        res.status(500).json({ error: err.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', templates: ['lag', 'approvd'] });
});

const PORT = process.env.PORT || 3200;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`PDF Filler service running on port ${PORT}`);
});