const express = require("express");
const bodyParser = require("body-parser");
const puppeteer = require("puppeteer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();


const app = express();


app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

const uploadsDir = path.join(__dirname, "uploads");
const logoPath = path.join(__dirname,'public', "cytonomics.png");
const base64Logo = fs.readFileSync(logoPath, "base64")
const logo = `data:image/png;base64,${base64Logo}`;


if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}
fs.chmodSync(uploadsDir, 0o777);
const ZOHO_WORKDRIVE_API = 'https://www.zohoapis.in/workdrive/api/v1';
app.get('/auth', (req, res) => {
    const authURL = `https://accounts.zoho.in/oauth/v2/auth?scope=WorkDrive.files.ALL&client_id=${process.env.ZOHO_CLIENT_ID}&response_type=code&access_type=offline&redirect_uri=${process.env.ZOHO_REDIRECT_URI}&state=register`;
    console.log('Redirecting to:', authURL); 
    res.redirect(authURL);
});
app.get('/admin/auth', (req, res) => {
    const authURL = `https://accounts.zoho.in/oauth/v2/auth?scope=WorkDrive.files.ALL&client_id=${process.env.ZOHO_CLIENT_ID}&response_type=code&access_type=offline&prompt=consent&redirect_uri=${process.env.ZOHO_REDIRECT_URI}`;
    res.redirect(authURL);
});
app.get('/oauth/callback', async (req, res) => {
    const { code } = req.query;
    
    console.log('Callback received with query params:', req.query);

    if (!code) {
        console.error('No code received');
        return res.status(400).send('No authorization code received');
    }

    try {
        console.log('Making token request with:', {
            code,
            client_id: process.env.ZOHO_CLIENT_ID,
            client_secret: process.env.ZOHO_CLIENT_SECRET,
            redirect_uri: process.env.ZOHO_REDIRECT_URI
        });
        
        const tokenResponse = `https://accounts.zoho.in/oauth/v2/token?code=${code}&client_secret=${process.env.ZOHO_CLIENT_SECRET}&redirect_uri=${process.env.ZOHO_REDIRECT_URI}&grant_type=authorization_code&client_id=${process.env.ZOHO_CLIENT_ID}`
          
        console.log('Token URL:', tokenResponse);

        // Make the request
        const response = await axios.post(tokenResponse);

        console.log('Token response:', response.data);
        
        if (!response.data.refresh_token || !response.data.access_token) {
            console.error('Token response missing tokens:', response.data);
            return res.status(500).send('Failed to get tokens from response');
        }

        res.send(`
            Authorization successful!<br/>
            Refresh Token: ${response.data.refresh_token}<br/>
            Access Token: ${response.data.access_token}<br/>
            <p>Please save the refresh token in your .env file.</p>
        `);
    } catch (error) {
        console.error('Error getting tokens:', error.response?.data || error.message);
        res.status(500).send(`Failed to get tokens: ${error.response?.data?.error || error.message}`);
    }
});
let tokenCache = {
    access_token: null,
    expires_at: null
};

async function getZohoAccessToken(forceRefresh = false) {
    try {
        // Check if we have a valid cached token
        if (!forceRefresh && tokenCache.access_token && tokenCache.expires_at && Date.now() < tokenCache.expires_at) {
            return tokenCache.access_token;
        }

        // Verify we have the refresh token
        if (!process.env.ZOHO_REFRESH_TOKEN) {
            console.error('No refresh token found. Please authenticate first.');
            throw new Error('No refresh token available');
        }

        console.log('Getting new access token...');

        // Create params
        const params = new URLSearchParams({
            refresh_token: process.env.ZOHO_REFRESH_TOKEN,
            client_id: process.env.ZOHO_CLIENT_ID,
            client_secret: process.env.ZOHO_CLIENT_SECRET,
            grant_type: 'refresh_token'
        });

        // Make the token request
        const response = await axios.post(
            'https://accounts.zoho.in/oauth/v2/token',
            params.toString(),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        console.log('Token response:', {
            success: true,
            expires_in: response.data.expires_in
        });

        // Cache the new token
        tokenCache.access_token = response.data.access_token;
        tokenCache.expires_at = Date.now() + ((response.data.expires_in - 300) * 1000); // Subtract 5 minutes for safety

        return tokenCache.access_token;

    } catch (error) {
        console.error('Token refresh error:', {
            message: error.message,
            response: error.response?.data,
            status: error.response?.status
        });

        // Clear token cache on error
        tokenCache.access_token = null;
        tokenCache.expires_at = null;

        throw new Error(`Failed to get access token: ${error.message}`);
    }
}

app.get('/test-zoho', async (req, res) => {
    try {
        const testData = {
            name: "Test User"
        };
        
        console.log('Testing with:', testData);
        const result = await submitToZohoForms(testData);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            details: error.response?.data
        });
    }
});
async function uploadToWorkDrive(pdfBuffer, fileName) {
    try {
         const accessToken = await getZohoAccessToken();
        const formData = new FormData();
        const fileStream = fs.createReadStream(uploadsDir + "/" + fileName);

        formData.append('content', fileStream, {
            filename: fileName,
            contentType: 'application/pdf'
        });
        
        formData.append('parent_id', process.env.ZOHO_WORKDRIVE_FOLDER_ID);

        console.log('Uploading file to WorkDrive:', {
            fileName,
            folderId: process.env.ZOHO_WORKDRIVE_FOLDER_ID
        });
        const response = await axios.post(
            `${ZOHO_WORKDRIVE_API}/upload`, 
            formData,
            {
                headers: {
                    'Authorization': `Zoho-oauthtoken ${accessToken}`,
                    ...formData.getHeaders(),
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            }
        );

        console.log('Upload response:', response.data);
        return response.data;
    } catch (error) {
        console.error('Upload error details:', {
            message: error.message,
            response: error.response?.data,
            errors: error.response?.data?.errors,
            status: error.response?.status,
            headers: error.config?.headers,
            requestData: {
                fileName,
                folderId: process.env.ZOHO_WORKDRIVE_FOLDER_ID,
                contentLength: pdfBuffer?.length
            }
        });
        throw error;
    }
}
async function submitToZohoForms(formData) {
    try {
        const params = new URLSearchParams();
        
        params.append('Name', formData.name || '');
        
        params.append('zf_referrer_name', 'https://forms.zohopublic.in');
        params.append('zf_redirect', 'false');
        params.append('zf_submitType', 'submit');
        params.append('zf_current_url', 'https://forms.zohopublic.in');
        params.append('zf_verify', 'false');
        params.append('zf_rszfm', '1');
        params.append('zf_form_id', '169131000000057033'); 

        console.log('Submitting data:', Object.fromEntries(params));

        const response = await axios({
            method: 'POST',
            url: 'https://forms.zohopublic.in/cytonomics/form/trf/formperma/NgsC0UajN151zsudoqxya1X_BpNBahQ2pOy9D3ZtrY8/htmlRecords/submit',
            data: params,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': '*/*',
                'Origin': 'https://forms.zohopublic.in',
                'Referer': 'https://forms.zohopublic.in/cytonomics/form/trf/formperma/NgsC0UajN151zsudoqxya1X_BpNBahQ2pOy9D3ZtrY8?zf_rszfm=1',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        console.log('Response:', response.data);
        return { success: true, data: response.data };
    } catch (error) {
        console.error('Submission error:', {
            message: error.message,
            response: error.response?.data
        });
        throw error;
    }
}

app.post("/generate-pdf", async (req, res) => {
 
    const formData = req.body;
    console.log(formData);

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    const safeFormData = {
        fullName: (formData.fullName || '').padEnd(40, ' '), 
    day: (formData.dob?.day || '').padEnd(2, ' '),
    month: (formData.dob?.month || '').padEnd(2, ' '),
    year: (formData.dob?.year || '').padEnd(4, ' '),
    age:{
        month: (formData.age?.month || '').padEnd(2, ' '),
        year: (formData.age?.year || '').padEnd(2, ' '),
    },
    ethnicity: (formData.ethnicity || '').padEnd(8, ' '),
    clinicianName: (formData.clinicianName || '').padEnd(38, ' '),
    hospitalName: (formData.hospitalName || '').padEnd(40, ' '), // Changed from hospital to hospitalName
    emails: {
        patientEmail: (formData.emails?.patientEmail || '').padEnd(33, ' '),
        referringClinicianEmail: (formData.emails?.referringClinicianEmail || '').padEnd(33, ' ')
    },
    numbers: {
        patientNumber: (formData.numbers?.patientNumber || '').padEnd(33, ' '),
        referringClinicianNumber: (formData.numbers?.referringClinicianNumber || '').padEnd(33, ' ')
    },
    texts: {
        sampleDetails1: (formData.texts?.sampleDetails1 || '').padEnd(33, ' '),
        sampleDetails2: (formData.texts?.sampleDetails2 || '').padEnd(33, ' '),
        sampleDetails3: (formData.texts?.sampleDetails3 || '').padEnd(33, ' '),
        sampleDetails4: (formData.texts?.sampleDetails4 || '').padEnd(33, ' '),
        colPatientName: (formData.texts?.colPatientName || '').padEnd(33, ' '),
        colPatientSignature: (formData.texts?.colPatientSignature || '').padEnd(33, ' '),
        colPatientRelationship: (formData.texts?.colPatientRelationship || '').padEnd(33, ' '),
        colPatientDate: (formData.texts?.colPatientDate || '').padEnd(33, ' '),
        colPatientClinicianName: (formData.texts?.colPatientClinicianName || '').padEnd(33, ' '),
        col2PatientName: (formData.texts?.col2PatientName || '').padEnd(33, ' '),
        col2PatientSignature: (formData.texts?.col2PatientSignature || '').padEnd(33, ' '),
        col2PatientAge: (formData.texts?.col2PatientAge || '').padEnd(33, ' '),
        col2PatientWife: (formData.texts?.col2PatientWife || '').padEnd(33, ' '),
        col2PatientAddress: (formData.texts?.col2PatientAddress || '').padEnd(33, ' '),
        relationshipName: (formData.texts?.relationshipName || '').padEnd(33, ' '),
        relationshipAddress: (formData.texts?.relationshipAddress || '').padEnd(33, ' '),
        relationshipRelationship: (formData.texts?.relationshipRelationship || '').padEnd(33, ' '),
        relationshipDate: (formData.texts?.relationshipDate || '').padEnd(33, ' '),
        relationshipPlace: (formData.texts?.relationshipPlace || '').padEnd(33, ' '),
        relationshipSignature: (formData.texts?.relationshipSignature || '').padEnd(33, ' '),
        col2PatientDate: (formData.texts?.col2PatientDate || '').padEnd(33, ' '),
        col2PatientPlace: (formData.texts?.col2PatientPlace || '').padEnd(33, ' '),
        col2PatientSignature: (formData.texts?.col2PatientSignature || '').padEnd(33, ' '),
        clinicalDetailsPedigree: (formData.texts?.clinicalDetailsPedigree || '').padEnd(33, ' '),
    },
    checkboxes: {
        checkboxM: formData.checkboxes?.checkboxM === "on" ? "checked" : "",
        checkboxF: formData.checkboxes?.checkboxF === "on" ? "checked" : "",
        checkboxWholeBlood: formData.checkboxes?.checkboxWholeBlood === "on" ? "checked" : "",
        checkboxEdta: formData.checkboxes?.checkboxEdta === "on" ? "checked" : "",
        checkboxSodiumHeparin: formData.checkboxes?.checkboxSodiumHeparin === "on" ? "checked" : "",
        checkboxStreckTube: formData.checkboxes?.checkboxStreckTube === "on" ? "checked" : "",
        CVS: formData.checkboxes?.CVS === "on" ? "checked" : "",
        amnioticFluid: formData.checkboxes?.amnioticFluid === "on" ? "checked" : "",
        artIvfYes: formData.checkboxes?.artIvfYes === "on" ? "checked" : "",
        artIvfNo: formData.checkboxes?.artIvfNo === "on" ? "checked" : "",
        noOfFetuses: formData.checkboxes?.noOfFetuses === "on" ? "checked" : "",
        cordBlood: formData.checkboxes?.cordBlood === "on" ? "checked" : "",
        productOfConception: formData.checkboxes?.productOfConception === "on" ? "checked" : "",
        driedBloodSpot: formData.checkboxes?.driedBloodSpot === "on" ? "checked" : "",
        extractedDNA: formData.checkboxes?.extractedDNA === "on" ? "checked" : "",
        semen: formData.checkboxes?.semen === "on" ? "checked" : "",
        embryo: formData.checkboxes?.embryo === "on" ? "checked" : "",
        noOfBiopsies: formData.checkboxes?.noOfBiopsies === "on" ? "checked" : "",
        sampleDays: formData.checkboxes?.sampleDays === "on" ? "checked" : "",
        prenatalSample: formData.checkboxes?.prenatalSample === "on" ? "checked" : "",
        donorGamete: formData.checkboxes?.donorGamete === "on" ? "checked" : "",
        statUrgent: formData.checkboxes?.statUrgent === "on" ? "checked" : "",
        serum: formData.checkboxes?.serum === "on" ? "checked" : "",
        checkbox1: formData.checkboxes?.checkbox1 === "on" ? "checked" : "",
        checkbox2: formData.checkboxes?.checkbox2 === "on" ? "checked" : "",
        extractedDNA: formData.checkboxes?.extractedDNA === "on" ? "checked" : "",
        statUrgent: formData.checkboxes?.statUrgent === "on" ? "checked" : "",
        molecularGeneticsWholeGenomeSequencing: formData.checkboxes?.molecularGeneticsWholeGenomeSequencing === "on" ? "checked" : "",
        mlpaHbb: formData.checkboxes?.mlpaHbb === "on" ? "checked" : "",
        mlpaHba: formData.checkboxes?.mlpaHba === "on" ? "checked" : "",
        mlpaOthers: formData.checkboxes?.mlpaOthers === "on" ? "checked" : "",
        friedreichsAtaxia: formData.checkboxes?.friedreichsAtaxia === "on" ? "checked" : "",
        tripleRepeatDisordersFshd: formData.checkboxes?.tripleRepeatDisordersFshd === "on" ? "checked" : "",
    
    
       
        

    
        // Biochemical Prenatal Screening
        doubleMarker: formData.checkboxes?.doubleMarker === "on" ? "checked" : "",
        quadrupleMark: formData.checkboxes?.quadrupleMark === "on" ? "checked" : "",
    
        // NIPT Tests
        nIPTFocus: formData.checkboxes?.nIPTFocus === "on" ? "checked" : "",
        nIPTComprehensive: formData.checkboxes?.nIPTComprehensive === "on" ? "checked" : "",
        nIPTPlus: formData.checkboxes?.nIPTPlus === "on" ? "checked" : "",
    
        // Pre-conception Tests
        preConceptionDoubleMarker: formData.checkboxes?.preConceptionDoubleMarker === "on" ? "checked" : "",
        preConceptionQuadrupleMark: formData.checkboxes?.preConceptionQuadrupleMark === "on" ? "checked" : "",
    
        // Carrier Screening
        carrierScreening: formData.checkboxes?.carrierScreening === "on" ? "checked" : "",
        prenatalScreeningSingle: formData.checkboxes?.prenatalScreeningSingle === "on" ? "checked" : "",
        prenatalScreeningCouple: formData.checkboxes?.prenatalScreeningCouple === "on" ? "checked" : "",
    
        // Genetic Testing
        infertilityGenePanel: formData.checkboxes?.infertilityGenePanel === "on" ? "checked" : "",
        preImplantationGeneticTesting: formData.checkboxes?.preImplantationGeneticTesting === "on" ? "checked" : "",
        aneuploidy: formData.checkboxes?.aneuploidy === "on" ? "checked" : "",
        structuralAberrations: formData.checkboxes?.structuralAberrations === "on" ? "checked" : "",
        prePGDWorkUp: formData.checkboxes?.prePGDWorkUp === "on" ? "checked" : "",
        yChromosomalMicrodeletion: formData.checkboxes?.yChromosomalMicrodeletion === "on" ? "checked" : "",
    
        // Cytogenetics
        cytogeneticskaryotyping: formData.checkboxes?.cytogeneticskaryotyping === "on" ? "checked" : "",
        cytogeneticsSingle: formData.checkboxes?.cytogeneticsSingle === "on" ? "checked" : "",
        cytogeneticsCouple: formData.checkboxes?.cytogeneticsCouple === "on" ? "checked" : "",
        cytogeneticsFish: formData.checkboxes?.cytogeneticsFish === "on" ? "checked" : "",
        cytogeneticsThreeProbes: formData.checkboxes?.cytogeneticsThreeProbes === "on" ? "checked" : "",
        cytogeneticsFiveProbes: formData.checkboxes?.cytogeneticsFiveProbes === "on" ? "checked" : "",
        cytogeneticsMicroarray: formData.checkboxes?.cytogeneticsMicroarray === "on" ? "checked" : "",
        cytogeneticsPrenatal: formData.checkboxes?.cytogeneticsPrenatal === "on" ? "checked" : "",
        cytogeneticsConstitutional: formData.checkboxes?.cytogeneticsConstitutional === "on" ? "checked" : "",
        cytogeneticsDeepdive: formData.checkboxes?.cytogeneticsDeepdive === "on" ? "checked" : "",
        cytogeneticsQfPcr: formData.checkboxes?.cytogeneticsQfPcr === "on" ? "checked" : "",
        cytogeneticsStressCytogenetics: formData.checkboxes?.cytogeneticsStressCytogenetics === "on" ? "checked" : "",
        cytogeneticsMaternalCellContamination: formData.checkboxes?.cytogeneticsMaternalCellContamination === "on" ? "checked" : "",
        cytogeneticsSpermDNAFragmentationStudy: formData.checkboxes?.cytogeneticsSpermDNAFragmentationStudy === "on" ? "checked" : "",
        cytogeneticsM: formData.checkboxes?.cytogeneticsM === "on" ? "checked" : "",
        cytogeneticsF: formData.checkboxes?.cytogeneticsF === "on" ? "checked" : "",
        molecularGeneticsTwoVariantsByNgs: formData.checkboxes?.molecularGeneticsTwoVariantsByNgs === "on" ? "checked" : "",
    
        // Molecular Genetics
        molecularGeneticsNextGenerationSequencing: formData.checkboxes?.molecularGeneticsNextGenerationSequencing === "on" ? "checked" : "",
        molecularGeneticsSangerSequencing: formData.checkboxes?.molecularGeneticsSangerSequencing === "on" ? "checked" : "",
        molecularGeneticsMlpa: formData.checkboxes?.molecularGeneticsMlpa === "on" ? "checked" : "",
        molecularGeneticsOrionFocus: formData.checkboxes?.molecularGeneticsOrionFocus === "on" ? "checked" : "",
        molecularGeneticsOrionPlus: formData.checkboxes?.molecularGeneticsOrionPlus === "on" ? "checked" : "",
        molecularGeneticsOrionSingleGene: formData.checkboxes?.molecularGeneticsOrionSingleGene === "on" ? "checked" : "",
        molecularGeneticsOrionWesGene: formData.checkboxes?.molecularGeneticsOrionWesGene === "on" ? "checked" : "",
        molecularGeneticsScaleUpToOrion: formData.checkboxes?.molecularGeneticsScaleUpToOrion === "on" ? "checked" : "",
        prenatalScreeningSingle: formData.checkboxes?.prenatalScreeningSingle === "on" ? "checked" : "",
        prenatalScreeningM: formData.checkboxes?.prenatalScreeningM === "on" ? "checked" : "",
        prenatalScreeningF: formData.checkboxes?.prenatalScreeningF === "on" ? "checked" : "",
        prenatalScreeningCouple: formData.checkboxes?.prenatalScreeningCouple === "on" ? "checked" : "",
        molecularGeneticsOthers: formData.checkboxes?.molecularGeneticsOthers === "on" ? "checked" : "",
        mlpaSma: formData.checkboxes?.mlpaSma === "on" ? "checked" : "",
        mlpaCah: formData.checkboxes?.mlpaCah === "on" ? "checked" : "",
        mlpaBrac12: formData.checkboxes?.mlpaBrac12 === "on" ? "checked" : "",
        mlpaDmd: formData.checkboxes?.mlpaDmd === "on" ? "checked" : "",
        mlpaPmp22: formData.checkboxes?.mlpaPmp22 === "on" ? "checked" : "",
        mlpaAhus: formData.checkboxes?.mlpaAhus === "on" ? "checked" : "",
        mlpaPws: formData.checkboxes?.mlpaPws === "on" ? "checked" : "",
        mlpaBeckwithWiedemann: formData.checkboxes?.mlpaBeckwithWiedemann === "on" ? "checked" : "",
        mlpaOthers: formData.checkboxes?.mlpaOthers === "on" ? "checked" : "",
        tripleRepeatDisordersFragileX: formData.checkboxes?.tripleRepeatDisordersFragileX === "on" ? "checked" : "",
        tripleRepeatDisordersHuntingtonDisease: formData.checkboxes?.tripleRepeatDisordersHuntingtonDisease === "on" ? "checked" : "",
        tripleRepeatDisordersSpinocerebrellarAtaxiaPanel: formData.checkboxes?.tripleRepeatDisordersSpinocerebrellarAtaxiaPanel === "on" ? "checked" : "",
        tripleRepeatDisordersMyotonicDystrophy: formData.checkboxes?.tripleRepeatDisordersMyotonicDystrophy === "on" ? "checked" : "",
        
        
    }
    };
    console.log("this safe data", safeFormData.checkboxes.checkboxM);

    // HTML content for PDF
    const htmlContent = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta content="text/html; charset=utf-8" http-equiv="Content-Type">
            <style>
                * { margin: 0; padding: 0; }
                body { font-family: Arial, sans-serif; }
                 .container {
            max-width: 1000px;
            margin: 0 auto;
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
            .header {
            color: #684287;
            text-align: center;
            margin-bottom: 20px;
        }
            </style>
        </head>
        <body>
    <div class="container">
    <table width="100%" bgcolor="#fefefe" align="center" style=" background: #fefefe; width: 100%; text-align: center; font-size: 11pt; font-family: Arial, Helvetica, sans-serif; line-height: 18px;" cellpadding="0" cellspacing="0">
        <tr>
            <td align="center">
                <table width="1000" cellspacing="0" cellpadding="0">
                    
                    <tr>
                        <td height="20" align="left" valign="center">
                            <a href="#">
                                <img src="${logo}" alt="logo" width="400" />
                            </a>    
                        </td>
                        <td height="20" align="right" valign="center" style="text-transform: uppercase;color: #684287;font-size: 28px;font-weight: 700;">
                            TEST REQUISITION FORM    
                        </td>
                    </tr>
                    <tr>
                        <td height="20" colspan="2" align="right">
                            &nbsp;
                        </td>
                    </tr>
                    <tr>
                        <td height="20" colspan="2" align="right">
                            &nbsp;
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
        <tr>
            <td align="center">
                <table width="1000" cellspacing="20" cellpadding="15" style="border: 1px solid #684287; border-radius: 10px;">
                    <tr>
                        <td colspan="4" height="20" align="center" valign="center" style="text-transform: uppercase;color: #684287;font-size: 23px;font-weight: 500;">
                            PATIENT DETAILS<br/>
                            <span style="font-size: 14px;font-weight: 400; text-transform: none;">(In BLOCK letters)</span>    
                        </td>
                    </tr>
                    <tr>
                        <td colspan="4" height="20" align="left" valign="center" style="color: #000;font-size: 16px;font-weight: 500;">
                           Full Name ${Array.from(safeFormData.fullName)
                              .map(
                                (char, index) =>
                                  `<input type="text" maxlength="1" value="${char}" class="char-input" style="border: 1px solid #684287; margin-right: 3px; height: 16px; width: 16px; text-align: center;" data-group="fullName-${index}" />`
                              )
                              .join("")}
                        </td>
                    </tr>
                    <tr>
                        <td align="left" valign="center" >
                            <table width="100%" cellspacing="0" cellpadding="0">
                                <tr>
                                    <td rowspan="2" valign="bottom" style="color: #000;font-size: 16px;font-weight: 500;">
                                        DOB
                                    </td>
                                    <td>
                                        <table width="100%"  cellspacing="0" cellpadding="0">
                                            <tr>
                                                <td align="center">DD</td>
                                                <td align="center">MM</td>
                                                <td align="center">YYYY</td>
                                            </tr>
                                            <tr>
                                                <td>
                                                    ${Array.from(
                                                      safeFormData.day
                                                    )
                                                      .map(
                                                        (char, index) =>
                                                          `<input type="text" maxlength="1" value="${char}" class="char-input" style="border: 1px solid #684287; height: 16px; width: 16px; text-align: center;" data-group="day-${index}" />`
                                                      )
                                                      .join("")}
                                                </td>
                                                
                                                <td>
                                                  ${Array.from(
                                                    safeFormData.month
                                                  )
                                                    .map(
                                                      (char, index) =>
                                                        `<input type="text" maxlength="1" value="${char}" class="char-input" style="border: 1px solid #684287; height: 16px; width: 16px; text-align: center;" data-group="month-${index}" />`
                                                    )
                                                    .join("")}
                                                </td>
                                                
                                                <td>
                                                    ${Array.from(
                                                      safeFormData.year
                                                    )
                                                      .map(
                                                        (char, index) =>
                                                          `<input type="text" maxlength="1" value="${char}" class="char-input" style="border: 1px solid #684287; height: 16px; width: 16px; text-align: center;" data-group="year-${index}" />`
                                                      )
                                                      .join("")}
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                        </td>
                        <td align="left" valign="center" >
                            <table width="100%" cellspacing="0" cellpadding="0">
                                <tr>
                                    <td valign="bottom" rowspan="2" style="color: #000;font-size: 16px;font-weight: 500;">
                                        Age
                                    </td>
                                    <td>
                                        <table width="100%"  cellspacing="0" cellpadding="0">
                                            <tr>
                                                <td align="left">YY</td>
                                                <td align="left">MM</td>
                                            </tr>
                                            <tr>
                                                <td>
                                                    ${Array.from(
                                                      safeFormData.age.year
                                                    )
                                                      .map(
                                                        (char, index) =>
                                                          `<input type="text" maxlength="1" value="${char}" class="char-input" style="border: 1px solid #684287; height: 16px; width: 16px; text-align: center;" data-group="year-${index}" />`
                                                      )
                                                      .join("")}
                                                </td>
                                                <td>
                                                    ${Array.from(
                                                      safeFormData.age.month
                                                    )
                                                      .map(
                                                        (char, index) =>
                                                          `<input type="text" maxlength="1" value="${char}" class="char-input" style="border: 1px solid #684287; height: 16px; width: 16px; text-align: center;" data-group="month-${index}" />`
                                                      )
                                                      .join("")}
                                                    /
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                        </td>
                        <td align="left" valign="center" >
                            <table width="100%" cellspacing="0" cellpadding="0">
                                <tr>
                                    <td valign="bottom" rowspan="2" style=" color: #000;font-size: 16px;font-weight: 500;">
                                        Gender
                                    </td>
                                    <td>
                                        <table width="100%"  cellspacing="0" cellpadding="0">
                                            <tr>
                                                <td align="center">&nbsp;</td>
                                                <td align="center">&nbsp;</td>
                                            </tr>
                                            <tr>
                                                <td>
                                                    <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                                                      safeFormData.checkboxes.checkboxM
                                                        ? "checked"
                                                        : ""
                                                    }/> M
                                                </td>
                                                <td>
                                                    <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                                                      safeFormData.checkboxes.checkboxF
                                                        ? "checked"
                                                        : ""
                                                    }/> F
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                        </td>
                        <td align="left" valign="center" >
                            <table width="100%" cellspacing="0" cellpadding="0">
                                <tr>
                                    <td valign="bottom" rowspan="2" style="color: #000;font-size: 16px;font-weight: 500;">
                                        Ethnicity
                                    </td>
                                    <td>
                                        <table width="100%"  cellspacing="0" cellpadding="0">
                                            <tr>
                                                <td align="center">&nbsp;</td>
                                            </tr>
                                            <tr> 
                                                <td>
                                                ${Array.from(
                                                  safeFormData.ethnicity
                                                )
                                                  .map(
                                                    (char, index) =>
                                                      `<input type="text" maxlength="1" value="${char}" class="char-input" style="border: 1px solid #684287; height: 16px; width: 16px; text-align: center;" data-group="ethnicity-${index}" />`
                                                  )
                                                  .join("")}
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    <tr>
                        <td colspan="2" align="left" valign="center" >
                            <table width="100%" cellspacing="0" cellpadding="0">
                                <tr>
                                    <td valign="middle" style="color: #000;font-size: 16px;font-weight: 500;">
                                        E-mail ID
                                    </td>
                                    <td align="left">
                                        <table width="100%"  cellspacing="0" cellpadding="0">
                                            
                                            <tr>
                                                <td align="left">
                                                    <input type="text" style="border: 1px solid #684287; height: 20px; width: 250px;" value="${
                                                      safeFormData.emails.patientEmail
                                                    }" />
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                        </td>
                        <td colspan="2" align="left" valign="center" >
                            <table width="100%" cellspacing="0" cellpadding="0">
                                <tr>
                                    <td valign="middle" style="color: #000;font-size: 16px;font-weight: 500;">
                                        Contact No.
                                    </td>
                                    <td align="left">
                                        <table width="100%"  cellspacing="0" cellpadding="0">
                                            
                                            <tr>
                                                <td align="left">
                                                    <input type="text" style="border: 1px solid #684287; height: 20px; width: 250px;" value="${
                                                      safeFormData.numbers.patientNumber
                                                    }" />
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
        <tr>
            <td height="20" colspan="2" align="right">
                &nbsp;
            </td>
        </tr>
        <tr>
            <td align="center">
                <table width="1000" cellspacing="20" cellpadding="15" style="border: 1px solid #684287; border-radius: 10px;">
                    <tr>
                        <td colspan="2" height="20" align="center" valign="center" style="text-transform: uppercase;color: #684287;font-size: 23px;font-weight: 500;">
                            REFERRING CLINICIAN<br/>
                            <span style="font-size: 14px;font-weight: 400; text-transform: none;">(In BLOCK letters)</span>    
                        </td>
                    </tr>
                    <tr>
                        <td colspan="4" height="20" align="left" valign="center" style="color: #000;font-size: 16px;font-weight: 500;">
                        Clinician Name

                            ${Array.from(safeFormData.clinicianName)
                              .map(
                                (char, index) =>
                                  `<input type="text" maxlength="1" class="char-input" style="border: 1px solid #684287; margin-right: 3px; height: 16px; width: 16px; text-align: center;" data-group="clinician-name-${index}" value="${char}" />`
                              )
                              .join("")}
                        </td>
                    </tr>
                    <tr>
                        <td colspan="4" height="20" align="left" valign="center" style="color: #000;font-size: 16px;font-weight: 500;">
                         Hospital

                            ${Array.from(safeFormData.hospitalName)
                              .map(
                                (char, index) =>
                                  `<input type="text" maxlength="1" class="char-input" style="border: 1px solid #684287; margin-right: 3px; height: 16px; width: 16px; text-align: center;" data-group="hospital-${index}" value="${char}" />`
                              )
                              .join("")}
                        </td>
                    </tr>
                    
                    <tr>
                        <td align="left" valign="center" >
                            <table width="100%" cellspacing="0" cellpadding="0">
                                <tr>
                                    <td width="100" valign="middle" style="color: #000;font-size: 16px;font-weight: 500;">
                                        E-mail ID
                                    </td>
                                    <td align="left">
                                        <table width="100%"  cellspacing="0" cellpadding="0">
                                            
                                            <tr>
                                                <td align="left">
                                                    <input type="text" style="border: 1px solid #684287; height: 20px; width: 250px;" value="${
                                                      safeFormData.emails.referringClinicianEmail
                                                    }" />
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                        </td>
                        <td align="left" valign="center" >
                            <table width="100%" cellspacing="0" cellpadding="0">
                                <tr>
                                    <td valign="middle" style="color: #000;font-size: 16px;font-weight: 500;">
                                        Contact No.
                                    </td>
                                    <td align="left">
                                        <table width="100%"  cellspacing="0" cellpadding="0">
                                            
                                            <tr>
                                                <td align="left">
                                                    <input type="text" style="border: 1px solid #684287; height: 20px; width: 250px;" value="${
                                                      safeFormData.numbers.referringClinicianNumber
                                                    }" />
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                        </td>
                        
                    </tr>
                    
                </table>
            </td>
        </tr>
        <tr>
            <td height="20" colspan="2" align="right">
                &nbsp;
            </td>
        </tr>
        <tr>
            <td align="center">
                <table width="1000" cellspacing="15" cellpadding="15" style="border: 1px solid #684287; border-radius: 10px;">
                    <tr>
                        <td colspan="4" height="20" align="center" valign="center" style="text-transform: uppercase;color: #684287;font-size: 23px;font-weight: 500;">
                            SAMPLE DETAILS    
                        </td>
                    </tr>
                    <tr>
                        <td colspan="4" height="20" align="left" valign="center" style="color: #684287;font-size: 16px;font-weight: 500;">
                            Sample Type
                        </td>
                    </tr>
                    <tr>
                        <td valign="center" width="25%" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.checkboxWholeBlood ? "checked" : ""
                            }> Whole Blood :
                        </td>
                        <td valign="center" width="25%" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.checkboxEdta ? "checked" : ""
                            }> EDTA(4 ml)
                        </td>
                        <td valign="center" width="25%" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.checkboxSodiumHeparin ? "checked" : ""
                            }> Sodium Heparin<br/><span style="font-size: 10px;">(Stress Cytogenetics Test 6 ml)</span>
                        </td>
                        <td valign="center" width="25%" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.checkboxStreckTube ? "checked" : ""
                            }> Streck Tube <span style="font-size: 10px;">(10 ml)</span>
                        </td>
                    </tr>
                    <tr>
                        <td valign="center" width="25%" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.amnioticFluid ? "checked" : ""
                            } > Amniotic Fluid <span style="font-size: 10px;">(20 ml)</span>
                        </td>
                        <td valign="center" width="25%" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.CVS ? "checked" : ""
                            }> CVS <span style="font-size: 10px;">(10-15 ug)</span>
                        </td>
                        <td valign="center" width="25%" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                            safeFormData.checkboxes.cordBlood ? "checked" : ""
                            }> Cord blood<br/><span style="font-size: 10px;">(2 ml)</span>
                        </td>
                        <td valign="center" width="25%" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.productOfConception ? "checked" : ""
                            }> Product of conception<br/> <span style="font-size: 10px;">(10-15 ug in normal saline with
                                10 drops of Gentamicin)</span>
                        </td>
                    </tr>
                    <tr>
                        <td valign="center" width="25%" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.serum ? "checked" : ""
                            }> Serum <span style="font-size: 10px;">(2 ml plain blood)</span>
                        </td>
                        <td valign="center" colspan="3" width="25%" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.driedBloodSpot ? "checked" : ""
                            }> Dried Blood Spot <span style="font-size: 10px;">(Please refer below for available tests)</span>
                        </td>
                    </tr>    
                    <tr>
                        <td valign="center" colspan="2" width="25%" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.extractedDNA ? "checked" : ""
                            }> Extracted DNA <span style="font-size: 10px;">[1000 ng (20 ul x 50 ng)]</span>
                        </td>
                        <td valign="center" colspan="2" width="25%" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.semen ? "checked" : ""
                            }> Semen <span style="font-size: 10px;">(4ml)</span>
                        </td>
                    </tr> 
                    <tr>
                        <td valign="center" width="25%" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.embryo ? "checked" : ""
                            }> Embryo
                        </td>
                        <td valign="center" width="25%" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.noOfBiopsies ? "checked" : ""
                            }> No. of biopsies
                        </td>
                        <td valign="center" colspan="2" width="25%" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.sampleDays ? "checked" : ""
                            }> Days <span style="font-size: 10px;">(Day 5 embryo biopsies are recommended)</span>
                        </td>
                    </tr>  
                    <tr>
                        <td valign="center" colspan="4" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.prenatalSample ? "checked" : ""
                            }> Prenatal Sample : Gestational age - wks <span style="font-size: 10px;">(for fetal sample)</span><br/><span style="font-size: 10px;">(Evaluation of maternal cell contamination is recommended for all prenatal molecular tests. Sample required: 4ml maternal EDTA Blood)
                            </span>
                        </td>
                    </tr>  
                    <tr>
                        <td valign="center" colspan="2" style="font-size: 14px;">
                            ART / IVF Pregnancy <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.artIvfYes ? "checked" : ""
                            }> Yes &nbsp; <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.artIvfNo ? "checked" : ""
                            }> No
                        </td>
                        <td valign="center" width="25%" style="font-size: 14px;">
                            No. of fetuses <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.noOfFetuses ? "checked" : ""
                            }> 
                        </td>
                        <td valign="center"  width="25%" style="font-size: 14px;">
                            Donor Gamete: <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.donorGamete ? "checked" : ""
                            }> Yes &nbsp; <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.donorGamete ? "checked" : ""
                            }> No
                        </td>
                    </tr> 
                    <tr>
                        <td valign="center" colspan="4" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.statUrgent ? "checked" : ""
                            }> Please indicate here if this sample needs a stat/urgent report <span style="font-size: 10px;">(Rush charge may apply)</span>
                        </td>
                    </tr>  
                </table>
            </td>
        </tr>
        <tr>
            <td height="20" colspan="2" align="right">
                &nbsp;
            </td>
        </tr>
        <tr>
            <td align="center">
                <table width="1000" cellspacing="15" cellpadding="15" style="border: 1px solid #684287; border-radius: 10px; margin-bottom: 30px;">
                    <tr>

                        <td colspan="3" height="20" align="center" valign="center" style="text-transform: uppercase;color: #684287;font-size: 23px;font-weight: 500;">
                            TEST REQUESTED<br/>
                            <span style="font-size: 14px;font-weight: 400; text-transform: none;">(Test details on pages 4 to 5)</span>    
                        </td>
                    </tr>
                    <tr>
                        <td colspan="3" height="20" align="left" valign="center" style="color: #684287;font-size: 16px;font-weight: 600;">
                            Prenatal Screening

                        </td>
                    </tr>
                    <tr>
                        <td colspan="3" valign="center" style="font-size: 14px;">
                         Non-Invasive Prenatal Testing (NIPT) : <span style="font-size: 10px;">(Whole blood in Streck tube) (Ultrasonography report is mandatory along with biochemical
                            marker report if available)</span>
                        </td>
                    </tr>
                    <tr>
                        <td valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.nIPTFocus ? "checked" : ""
                            }> NIPT Basic<br/> <span style="font-size: 10px;">(Analysis & reporting of aneuploidies in 5<br/>
                                common chromosomes (13,18, 21, X & Y))</span>
                        </td>
                        <td valign="center" style="font-size: 14px;">

                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.nIPTComprehensive ? "checked" : ""
                            }> NIPT ADVANCED<br/> <span style="font-size: 10px;">(Analysis and reporting of aneuploidies<br/>
                                in all 23 Chromosomes)</span>
                        </td>

                        <td valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.nIPTPlus ? "checked" : ""
                            }> NIPT PREMIUM<br/> <span style="font-size: 10px;">(Analysis and reporting of aneuploidies in all<br/>
                                23 Chromosomes + 6 common microdeletions)</span>
                        </td>
                    </tr>
                    </table>
                    <br/>
                     <tr>
            <td align="center">
                <table width="1000" cellspacing="0" cellpadding="0">
                    
                    <tr>
                        <td height="20" align="left" valign="center">
                            <a href="#">
                                <img src="${logo}" alt="logo" width="400" />
                            </a>    
                        </td>
                        <td height="20" align="right" valign="center" style="text-transform: uppercase;color: #684287;font-size: 28px;font-weight: 700;">
                            TEST REQUISITION FORM    
                        </td>
                    </tr>
                    <tr>
                        <td height="20" colspan="2" align="right">
                            &nbsp;
                        </td>
                    </tr>
                    <tr>
                        <td height="20" colspan="2" align="right">
                            &nbsp;
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
                     <table width="1000" cellspacing="15" cellpadding="15" style="border: 1px solid #684287; border-radius: 10px;margin-top: 30px;">
                    <tr>
                        <td colspan="3" height="20" align="center" valign="center" style="text-transform: uppercase;color: #684287;font-size: 23px;font-weight: 500;">
                            TEST REQUESTED<br/>
                            <span style="font-size: 14px;font-weight: 400; text-transform: none;">(Test details on pages 4 to 5)</span>    
                        </td>
                    </tr>
                    <tr>
                        <td colspan="3" height="20" align="left" valign="center" style="color: #684287;font-size: 16px;font-weight: 600;">
                            Pre-conception Genetic Testing

                        </td>
                    </tr>
                    <tr>
                        <td valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.carrierScreening ? "checked" : ""
                            }> Carrier Screening<br/> <span style="font-size: 10px;">( > 2500 AR genes - NGS)</span>
                        </td>
                        <td  valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.prenatalScreeningSingle
                                ? "checked"
                                : ""
                            }> Single &nbsp; &nbsp; <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
      safeFormData.checkboxes.prenatalScreeningM ? "checked" : ""
    }> M <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
      safeFormData.checkboxes.prenatalScreeningF ? "checked" : ""
    }> F
                        </td>
                        <td  valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.prenatalScreeningCouple
                                ? "checked"
                                : ""
                            }> Couple 
                        </td>
                    </tr>
                    <tr>
                        <td colspan="3" valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.infertilityGenePanel ? "checked" : ""
                            }> Infertility Gene panel (CLINICAL EXOME SEQUENCING)
                        </td>
                    </tr>
                   
                    <tr>
                        <td colspan="3" valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.yChromosomalMicrodeletion
                                ? "checked"
                                : ""
                            }> Y - Chromosomal Microdeletion
                        </td>
                    </tr>
                    <tr>
                        <td colspan="3" height="20" align="left" valign="center" style="color: #684287;font-size: 16px;font-weight: 600;">
                            Cytogenetics
                        </td>
                    </tr>
                    <tr>
                        <td valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.cytogeneticskaryotyping ? "checked" : ""
                            }> Karyotyping <span style="font-size: 10px;"> (Blood in Sodium Heparin/Amniotic Fluid/Cord blood)</span>
                        </td>
                        <td valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.cytogeneticsSingle ? "checked" : ""
                            }> Single &nbsp; &nbsp; <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
      safeFormData.checkboxes.cytogeneticsM ? "checked" : ""
    }> M <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
      safeFormData.checkboxes.cytogeneticsF ? "checked" : ""
    }> F
                        </td>
                        <td valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.cytogeneticsCouple ? "checked" : ""
                            }> Couple 
                        </td>
                    </tr>
                    <tr>
                        <td valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.cytogeneticsFish ? "checked" : ""
                            }> FISH</span>
                        </td>
                        <td colspan="2" valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.cytogeneticsThreeProbes ? "checked" : ""
                            }> (3 probes-13, 18, 21) <span style="font-size: 10px;">(*Amniotic fluid / *CVS/ Sodium Heparin/ Cord blood)</span>
                        </td>
                    </tr>
                    <tr>
                        <td valign="center" style="font-size: 14px;">
                            &nbsp;
                        </td>
                        <td colspan="2" valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.cytogeneticsFiveProbes ? "checked" : ""
                            }> (5 probes-13, 18, 21, X, Y) <span style="font-size: 10px;"> (*Amniotic fluid / *CVS/ Sodium Heparin/ Cord blood)</span>
                        </td>
                    </tr>
                    <tr>
                        <td valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.cytogeneticsMicroarray ? "checked" : ""
                            }> Microarray</span>
                        </td>
                        <td colspan="2" valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.cytogeneticsPrenatal ? "checked" : ""
                            }> Prenatal (315K-Cytoscan Optima Low resolution - Prenatal 315K) <span style="font-size: 10px;"> (*Amniotic fluid / *CVS / Extracted DNA)</span>
                        </td>
                    </tr>
                    <tr>
                        <td valign="center" style="font-size: 14px;">
                            &nbsp;
                        </td>
                        <td colspan="2" valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.cytogeneticsConstitutional ? "checked" : ""
                            }>Low resolution - Postnatal (315K) <span style="font-size: 10px;"> (*POC / Extracted DNA / Whole blood in EDTA / Dried Blood spot)<br/>(Detects deletions upto 1Mb in size and duplication upto 2 Mb in size.)</span>
                        </td>
                    </tr>
                    <tr>
                        <td valign="center" style="font-size: 14px;">
                            &nbsp;
                        </td>
                        <td colspan="2" valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.cytogeneticsDeepdive ? "checked" : ""
                            }> High resolution (750K) <span style="font-size: 10px;"> (*Amniotic fluid / *CVS / *POC / Extracted DNA / Whole blood in EDTA / Dried Blood spot)<br/>(Detects deletions and duplication upto 200kb in size.)</span>
                        </td>
                    </tr>
                    <tr>
                        <td colspan="3" valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.cytogeneticsQfPcr
                                ? "checked"
                                : ""
                            }> QF-PCR for Aneuploidy Detection
                        </td>
                    </tr>
                    <tr>
                        <td colspan="3" valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.cytogeneticsMaternalCellContamination
                                ? "checked"
                                : ""
                            }> Maternal Cell Contamination <span style="font-size: 10px;">(Maternal blood in EDTA) &nbsp; &nbsp; (*Recommended during prenatal testing - AF / CVS / Cord blood / POC)</span>
                        </td>
                    </tr>
                    <tr>
                        <td valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.cytogeneticsSpermDNAFragmentationStudy
                                ? "checked"
                                : ""
                            }> Sperm DNA Fragmentation Study <span style="font-size: 10px;">(Semen)</span>
                        </td>
                        <td colspan="2" valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.cytogeneticsStressCytogenetics ? "checked" : ""
                            }> Stress Cytogenetics <span style="font-size: 10px;">(Sodium Heparin Blood)</span>
                        </td>
                    </tr>
                    <tr>
                        <td colspan="3" height="20" align="left" valign="center" style="color: #684287;font-size: 16px;font-weight: 600;">
                            Molecular Genetics
                        </td>
                    </tr>
                    <tr>
                        <td colspan="3" valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.molecularGeneticsSangerSequencing ? "checked" : ""
                            }> Sanger sequencing  <span style="font-size: 10px;"> (Requested for__________ gene /___________ variant)<br/>(*Amniotic fluid / *CVS) (Copy of previous genetic test report is mandatory)</span>
                        </td>
                    </tr>
                    <tr>
                        <td colspan="3" valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.molecularGeneticsNextGenerationSequencing
                                ? "checked"
                                : ""
                            }> Single Variant by NGS  <span style="font-size: 10px;">  (Extracted DNA/ Whole Blood EDTA/ Amniotic Fluid/ CVS/ Dried Blood Spot)
                        </td>
                         <tr>
                        <td colspan="3" valign="center" style="font-size: 14px;">
                            <input type="checkbox"  style="border: 1px solid #684287; height: 16px; width: 16px;" ${safeFormData.checkboxes.molecularGeneticsTwoVariantsByNgs ? "checked" : ""}> Two Variants by NGS <span style="font-size: 10px;">  (Extracted DNA/ Whole Blood EDTA/ Amniotic Fluid/ CVS/ Dried Blood Spot)
                        </td>
                    </tr>
                            </span>
                        </td>
                    </tr>
                    <tr>
                        <td valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.molecularGeneticsOrionSingleGene ? "checked" : ""
                            }> Single Gene Panel<br/> <span style="font-size: 10px;">(Requested for__________ gene)
                            </span>
                        </td>
                        <td colspan="2" valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.molecularGeneticsOrionFocus ? "checked" : ""
                            }>  Clinical Exome Sequencing<br/> <span style="font-size: 10px;">(Pre designed disease specific gene panel)<br/>*Please contact for gene list & panel details</span>
                        </td>
                    </tr>
                    <tr>
                        <td valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.molecularGeneticsOrionWesGene ? "checked" : ""
                            }> Whole Exome Sequencing<br/> <span style="font-size: 10px;">(Phenotype based Whole Exome<br/>+CNV Analysis) (Please specify Phenotype)
                            </span>
                        </td>
                        <td valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.molecularGeneticsScaleUpToOrion ? "checked" : ""
                            }> Whole Exome Sequencing Rapid<br/> <span style="font-size: 10px;">(TAT - 21 working days)</span>
                        </td>
                        <td valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${
                              safeFormData.checkboxes.molecularGeneticsOrionPlus ? "checked" : ""
                            }> Whole Exome Sequencing (WES) + Mitochondrial
Genome Sequencing”<br/> <span style="font-size: 10px;">(Phenotype based Whole Exome + CNV<br/>
                                Analysis + Mitochondrial Genome Sequencing)</span>
                        </td>
                        <tr>
                        <td valign="center" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${safeFormData.checkboxes.molecularGeneticsWholeGenomeSequencing ? "checked" : ""}>   Whole Genome Sequencing (WGS)<br/>
                        </td>
                        </tr>
                    </tr>
                </table>
            </td>
        </tr>
        <tr>
            <td align="center">
                <table width="1000" cellspacing="0" cellpadding="0">
                    <tr>
                        <td valign="center" align="left" style="font-size: 10px;font-weight: 500;">
                            *Please contact Helix Gene Research for more details
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
        <tr>
            <td height="20" colspan="2" align="right">
                &nbsp;
            </td>
        </tr>
          <tr>
            <td align="center">
                <table width="1000" cellspacing="0" cellpadding="0">
                    
                    <tr>
                        <td height="50" align="left" valign="center">
                               
                        </td>
                       
                    </tr>
                    <tr>
                        <td height="70" colspan="2" align="right">
                            &nbsp;
                        </td>
                    </tr>
                    <tr>
                        <td height="70" colspan="2" align="right">
                            &nbsp;
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
          <tr>
            <td align="center">
                <table width="1000" cellspacing="0" cellpadding="0">
                    
                    <tr>
                        <td height="20" align="left" valign="center">
                            <a href="#">
                                <img src="${logo}" alt="logo" width="400" />
                            </a>    
                        </td>
                        <td height="20" align="right" valign="center" style="text-transform: uppercase;color: #684287;font-size: 28px;font-weight: 700;">
                            TEST REQUISITION FORM    
                        </td>
                    </tr>
                    <tr>
                        <td height="20" colspan="2" align="right">
                            &nbsp;
                        </td>
                    </tr>
                    <tr>
                        <td height="20" colspan="2" align="right">
                            &nbsp;
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
            <td align="center">
                <table width="1000" cellspacing="15" cellpadding="15" style="border: 1px solid #684287; border-radius: 10px;">
                    <tr>

                        <td colspan="4" height="20" align="center" valign="center" style="text-transform: uppercase;color: #684287;font-size: 23px;font-weight: 500;">
                            Non NGS Based Tests    
                        </td>
                    </tr>
                    <tr>
                        <td colspan="4" height="20" align="left" valign="center" style="color: #684287;font-size: 16px;font-weight: 600;">
                            MLPA
                        </td>
                    </tr>
                    <tr>
                        <td colspan="3" valign="left" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${safeFormData.checkboxes.mlpaSma ? "checked" : ""}> SMA 
                        </td>
                        <td colspan="3" valign="left" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${safeFormData.checkboxes.mlpaHbb ? "checked" : ""}> HBB
                        </td>
                      

                        <tr>
                        <td colspan="3" valign="left" style="font-size: 14px;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${safeFormData.checkboxes.mlpaHba ? "checked" : ""}> HBA
                        </td>
                        <td colspan="3" valign="left" style="font-size: 14px;">

                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${safeFormData.checkboxes.mlpaCah ? "checked" : ""}> CAH (CYP21A2)
                        </td>
                        </tr>
                        <tr>
                        <td colspan="3" valign="left" style="font-size: 14px;">

                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${safeFormData.checkboxes.mlpaBrac12 ? "checked" : ""}>BRCA1/2
                        </td>
                        <td colspan="3" valign="left" style="font-size: 14px;">

                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${safeFormData.checkboxes.mlpaDmd ? "checked" : ""}> DMD
                        </td>
                        </tr>
                        <tr>
                        <td colspan="3" valign="left" style="font-size: 14px;">

                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${safeFormData.checkboxes.mlpaPmp22 ? "checked" : ""}> PMP22
                        </td>
                        <td colspan="3" valign="left" style="font-size: 14px;">

                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${safeFormData.checkboxes.mlpaAhus ? "checked" : ""}> aHUS (CFHR1/2/3/4/5)
                        </td>
                        </tr>
                        <tr>

                            <td colspan="4" height="20" align="left" valign="center" style="color: #684287;font-size: 16px;font-weight: 600;">
                                MS- MLPA
                            </td>
                        </tr>
                        <tr>
                            <td colspan="3" valign="left" style="font-size: 14px;">
                                <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${safeFormData.checkboxes.mlpaPws ? "checked" : ""}> Prader Willi / Angelman Syndrome 
                            </td>
                            <td colspan="3" valign="left" style="font-size: 14px;">

                                <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${safeFormData.checkboxes.mlpaBeckwithWiedemann ? "checked" : ""}>Beckwith Wiedemann - RussellSilver Syndrome
                            </td>
                          

                            <tr>
                            <td colspan="3" valign="left" style="font-size: 14px;">
                                <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${safeFormData.checkboxes.mlpaOthers ? "checked" : ""}> MLPA (Others) <span style="font-size: 10px;">: Please mention Gene disorder/ Gene Name to be tested</span>
                            </td>
                            </tr>

                            <tr>
                                <td colspan="4" height="20" align="left" valign="center" style="color: #684287;font-size: 16px;font-weight: 600;">
                                    Triple Repeat Disorders
                                </td>
                            </tr>
                            <tr>
                                <td colspan="3" valign="left" style="font-size: 14px;">
                                    <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${safeFormData.checkboxes.tripleRepeatDisordersFragileX ? "checked" : ""}> Fragile X


                                </td>
                                <td colspan="3" valign="left" style="font-size: 14px;">
                                    <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${safeFormData.checkboxes.tripleRepeatDisordersHuntingtonDisease ? "checked" : ""}> Huntington Disease


                                </td>
                              
                                <tr>
                                <td colspan="3" valign="left" style="font-size: 14px;">
                                    <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${safeFormData.checkboxes.tripleRepeatDisordersSpinocerebrellarAtaxiaPanel ? "checked" : ""}> Spinocerebrellar Ataxia Panel ( SCA 1,2,3,6,7,10,12 +DRPLA)
        

                                </td>
                                <td colspan="3" valign="left" style="font-size: 14px;">
                                    <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${safeFormData.checkboxes.tripleRepeatDisordersMyotonicDystrophy ? "checked" : ""}> Myotonic Dystrophy


                                </td>
                                </tr>
                                <tr>
                                <td colspan="3" valign="left" style="font-size: 14px;">
                                    <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${safeFormData.checkboxes.friedreichsAtaxia ? "checked" : ""}> Friedreich’s Ataxia
        


                                </td>
                                <td colspan="3" valign="left" style="font-size: 14px;">
                                    <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${safeFormData.checkboxes.tripleRepeatDisordersFshd ? "checked" : ""}> FSHD ( OGM- Optical Genome Mapping)

        

                                </td>
                                </tr>
                        
                </table>
            </td>
        </tr>
        <tr>
            <td height="20" colspan="2" align="right">
                &nbsp;
            </td>
        </tr>
        <tr>
            <td align="center">
                <table width="1000" cellspacing="15" cellpadding="15" style="border: 1px solid #684287; border-radius: 10px; ">
                    <tr>
                        <td colspan="4" height="20" align="center" valign="center" style="text-transform: uppercase;color: #684287;font-size: 23px;font-weight: 500;">
                            CLINICAL DIAGNOSIS   
                        </td>
                    </tr>
                    <tr>
                        <td colspan="4" height="20" align="left" valign="center" style="color: #684287;font-size: 16px;font-weight: 500;">
                            Clinical Details / Pedigree : <input type="text" name="clinicalDetailsPedigree" class="details-input" style="width: 50%; border: none;" value=${safeFormData.texts?.clinicalDetailsPedigree || ''} >
                        </td>
                    </tr>
                    <tr>
                        <td colspan="4" height="20" align="left" valign="center" style="color: #000;font-size: 13px;font-weight: 500;">
                            (Please provide detailed clinical information including age of onset of symptoms, disease progression, current status, response to treatment,
presence of consanguinity, family history and relevant investigations performed.)

                        </td>
                    </tr>
                    <tr>
                        <td height="80" colspan="4" align="right">
                            &nbsp;
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
        <tr>
            <td height="20" colspan="2" align="right">
                &nbsp;
            </td>
        </tr>
       

        <tr>
            <td align="center">
                <table width="1000" cellspacing="15" cellpadding="15" style="margin-top: 50px;">
                    <tr>
                        <td colspan="4" height="20" align="left" valign="center" style="color: #684287;font-size: 16px;font-weight: 500;">
                            Details of samples sent along with for additional testing
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
        <tr>
            <td align="center">
                <table width="1000" cellspacing="15" cellpadding="15" bgcolor="#f0f1f1" style="border-radius: 10px;">
                    <tr>
                        <td height="20" align="left" valign="center" style="color: #684287;font-size: 15px;font-weight: 500;">
                            &nbsp;
                        </td>
                        <td height="20" align="left" valign="center" style="color: #684287;font-size: 15px;font-weight: 500;">
                            Name
                        </td>
                        <td height="20" align="left" valign="center" style="color: #684287;font-size: 15px;font-weight: 500;">
                            DOB / Age
                        </td>
                        <td height="20" align="left" valign="center" style="color: #684287;font-size: 15px;font-weight: 500;">
                            Relationship<br/> <span style="font-size: 11px;">(with patient)</span>
                        </td>
                        <td height="20" align="left" valign="center" style="color: #684287;font-size: 15px;font-weight: 500;">
                            Affected<br/> <span style="font-size: 11px;">(Yes / No)</span>
                        </td>
                        <td height="20" align="left" valign="center" style="color: #684287;font-size: 15px;font-weight: 500;">
                            Details
                        </td>
                    </tr>
                    <tr>
                        <td align="left" valign="center" style="color: #000;font-size: 15px;font-weight: 500;" colspan="6">
                            1) <input type="text" style="width: 80%; border: none; border-bottom: 1px solid #000; background-color: rgb(240, 241, 241);" value=${safeFormData.texts?.sampleDetails1 || ''}>
                        </td>
                    </tr>
                    <tr>
                        <td align="left" valign="center" style="color: #000;font-size: 15px;font-weight: 500;" colspan="6">
                            2)<input type="text" style="width: 80%; border: none; border-bottom: 1px solid #000; background-color: rgb(240, 241, 241);" value=${safeFormData.texts?.sampleDetails2 || ''}>
                        </td>
                    </tr>
                    <tr>
                        <td colspan="6" align="left" valign="center" style="color: #000;font-size: 15px;font-weight: 500;">
                            3)<input type="text" style="width: 80%; border: none; border-bottom: 1px solid #000; background-color: rgb(240, 241, 241);" value=${safeFormData.texts?.sampleDetails3 || ''}>
                    </tr>
                    <tr>
                        <td align="left" valign="center" style="color: #000;font-size: 15px;font-weight: 500;" colspan="6">
                            4) <input type="text" style="width: 80%; border: none; border-bottom: 1px solid #000; background-color: rgb(240, 241, 241);" value=${safeFormData.texts?.sampleDetails4 || ''}>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
        <tr>
            <td height="20" colspan="2" align="right">
                &nbsp;
            </td>
        </tr>
        
        <tr>
            <td align="center">
                <table width="1000" cellspacing="15" cellpadding="15">
                    <tr>
                        <td height="20" align="left" valign="center" style="color: #684287;font-size: 15px;font-weight: 500;">
                            I have had the opportunity to ask questions to my healthcare provider regarding this test, including the reliability of test
            results, the risks and the alternatives prior to giving my informed consent.
                        </td>
                    </tr>
                    <tr>
                        <td height="20" align="left" valign="center" style="color: #684287;font-size: 15px;font-weight: 500;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${safeFormData.checkboxes.checkbox1 ? "checked" : ""}> I have read and understood the above/have been explained the above in a language of my understanding and
                            permit NCGM to perform the recommended genetic analysis.
                        </td>
                    </tr>
                    <tr>
                        <td height="20" align="left" valign="center" style="color: #684287;font-size: 15px;font-weight: 500;">
                            <input type="checkbox" style="border: 1px solid #684287; height: 16px; width: 16px;" ${safeFormData.checkboxes.checkbox2 ? "checked" : ""}> I understand that the data derived from my genetic testing may be stored indenitely as a part
                            of the laboratory database. This data is always stored in de-identied form. I understand my de-identied data/
                            sample may be used for research collaborations as well as scientic presentations and publications.
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
         <tr>
            <td align="center">
                <table width="1000" cellspacing="0" cellpadding="0">
                    
                    <tr>
                        <td height="20" align="left" valign="center">
                            <a href="#">
                                <img src="${logo}" alt="logo" width="400" />
                            </a>    
                        </td>
                        <td height="20" align="right" valign="center" style="text-transform: uppercase;color: #684287;font-size: 28px;font-weight: 700;">
                            TEST REQUISITION FORM    
                        </td>
                    </tr>
                    <tr>
                        <td height="20" colspan="2" align="right">
                            &nbsp;
                        </td>
                    </tr>
                    <tr>
                        <td height="20" colspan="2" align="right">
                            &nbsp;
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
              
        <tr>
            <td height="20" colspan="2" align="right">
                &nbsp;
            </td>
        </tr>
        <tr>
            <td align="center">
                <table width="1000" cellspacing="15" cellpadding="15" bgcolor="#f0f1f1" style="border-radius: 10px;">
                    <tr>
                        <td height="20" align="left" valign="center" style="color: #684287;font-size: 15px;font-weight: 500;">
                            Name: <input type="text" style="width: 50%; border: none;  background-color: rgb(240, 241, 241);" value=${safeFormData.texts?.colPatientName || ''}>
                        </td>
                        <td height="20" align="left" valign="center" style="color: #684287;font-size: 15px;font-weight: 500;">
                            Signature: <input type="text" style="width: 50%; border: none;  background-color: rgb(240, 241, 241);" value=${safeFormData.texts?.colPatientSignature || ''}>
                        </td>
                    </tr>
                    <tr>
                        <td height="20" align="left" valign="center" style="color: #684287;font-size: 15px;font-weight: 500;">
                            Relationship to Patient: <input type="text" style="width: 50%; border: none; background-color: rgb(240, 241, 241);" value=${safeFormData.texts?.colPatientRelationship || ''}>
                        </td>
                        <td height="20" align="left" valign="center" style="color: #684287;font-size: 15px;font-weight: 500;">
                            Date, Time and Place: <input type="text" style="width: 50%; border: none; background-color: rgb(240, 241, 241);" value=${safeFormData.texts?.colPatientDate || ''}>
                        </td>
                    </tr>
                    <tr>
                        <td colspan="2" height="20" align="left" valign="center" style="color: #684287;font-size: 15px;font-weight: 500;">
                         &nbsp;
                        </td>
                    </tr>
                    <tr>
                        <td colspan="2" height="20" align="left" valign="center" style="color: #684287;font-size: 15px;font-weight: 500;">
                            Clinician Name & Signature: <input type="text" style="width: 50%; border: none; background-color: rgb(240, 241, 241);" value=${safeFormData.texts?.colPatientClinicianName || ''}>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
        <tr>
            <td height="20" colspan="2" align="right">
                &nbsp;
            </td>
        </tr>
        <tr>
            <td height="20" colspan="2" align="right">
                &nbsp;
            </td>
        </tr>
        <tr>
            <td align="center">
                <table width="1000" cellspacing="7" cellpadding="7" style="border-radius: 10px;">
                    <tr>
                        <td colspan="2" height="20" align="center" valign="center" style="color: #404041;font-size: 18px;font-weight: 600;">
                            F O R M - G
                        </td>
                    </tr>
                    <tr>
                        <td colspan="2" height="20" align="center" valign="center" style="color: #404041;font-size: 18px;font-weight: 500;">
                            [See Rule 10]
                        </td>
                    </tr>
                    <tr>
                        <td colspan="2" height="20" align="center" valign="center" style="color: #404041;font-size: 18px;font-weight: 600;">
                            FORM OF CONSENT 
                        </td>
                    </tr>
                    <tr>
                        <td colspan="2" height="20" align="center" valign="center" style="color: #404041;font-size: 15px;font-weight: 500;">
                            (For Non-invasive / invasive techniques)
                        </td>
                    </tr>
                    <tr>
                        <td colspan="2" align="left" valign="center" style="color: #404041;font-size: 14px;font-weight: 500;">
                            I, <input type="text" style="width: 50%; border: none;border-bottom: 1px solid #000; " value="${safeFormData.texts?.col2PatientName || ''}"> age  <input type="text" style="width: 20%; border: none;border-bottom: 1px solid #000;" value="${safeFormData.texts?.col2PatientAge || ''}">  yrs, wife/daughter of
    <input type="text" style="width: 50%; border: none;border-bottom: 1px solid #000;" value="${safeFormData.texts?.col2PatientWife || ''}">    residing at (address)   <input type="text" style="width: 50%; border: none;border-bottom: 1px solid #000;" value="${safeFormData.texts?.col2PatientAddress || ''}">,  hereby state that I have been explained fully the probable
side eects and after-eects of the prenatal diagnostic procedures. I wish to undergo the
pre-natal diagnostic procedures in my interest, to nd out the possibility and abnormality
(i.e. deformity/deformity/disorder) in the child, I am carrying.
                        </td>
                    </tr>
                    <tr>
                        <td colspan="2" align="left" valign="center" style="color: #404041;font-size: 14px;font-weight: 500;">
                            I undertake not to terminate the pregnancy if the pre-natal procedure/technique/test conducted
show the absence of disease/deformity/disorder
                        </td>
                    </tr>
                    <tr>
                        <td colspan="2" align="left" valign="center" style="color: #404041;font-size: 14px;font-weight: 500;">
                            I understand that the sex of the fetus will not be disclosed to me.
                        </td>
                    </tr>
                    <tr>
                        <td colspan="2" align="left" valign="center" style="color: #404041;font-size: 14px;font-weight: 500;">
                            I understand that breach of this undertaking will make me liable to penalty as prescribed in
the Prenatal Diagnostic Technique (Regulation and Prevention of Misuse) Act, 1994 (57 of 1994).
                        </td>
                    </tr>
                    <tr>
                        <td colspan="2" align="left" valign="center" style="color: #404041;font-size: 14px;font-weight: 500;">
                            Date :<input type="text" style="width: 20%; border: none;border-bottom: 1px solid #000; " value=${safeFormData.texts?.col2PatientDate || ''}>
                        </td>
                    </tr>
                    <tr>
                        <td align="left" valign="center" style="color: #404041;font-size: 14px;font-weight: 500;">
                            Place : <input type="text" style="width: 20%; border: none;border-bottom: 1px solid #000; " value=${safeFormData.texts?.col2PatientPlace || ''}>
                        </td>
                        <td align="right" valign="center" style="color: #404041;font-size: 14px;font-weight: 500;">
                           
                            Signature of Patient:  ${safeFormData.texts?.col2PatientSignature || ''}
                        </td>
                    </tr>
                    <tr>
                        <td colspan="2" align="left" valign="center" style="color: #404041;font-size: 14px;font-weight: 500;">
                            I have explained the contents of the above consent form to the patient and/or her companion 
                        </td>
                    </tr>
                    <tr>
                        <td colspan="2" align="left" valign="center" style="color: #404041;font-size: 14px;font-weight: 500;">
                            (Name<input type="text" style="width: 20%; border: none;border-bottom: 1px solid #000;" value=${safeFormData.texts?.relationshipName || ''}> Address <input type="text" style="width: 40%; border: none;border-bottom: 1px solid #000;" value=${safeFormData.texts?.relationshipAddress || ''}> Relationship <input type="text" style="width: 30%; border: none;border-bottom: 1px solid #000;" value=${safeFormData.texts?.relationshipRelationship || ''}> ) in a language she/they understand.  
                        </td>
                    </tr>
                    <tr>
                        <td colspan="2" align="left" valign="center" style="color: #404041;font-size: 14px;font-weight: 500;">
                            Date : <input type="text" style="width: 20%; border: none;border-bottom: 1px solid #000;" value=${safeFormData.texts?.relationshipDate || ''}>
                        </td>
                    </tr>
                    <tr>
                        <td align="left" valign="center" style="color: #404041;font-size: 14px;font-weight: 500;">
                            Place : <input type="text" style="width: 20%; border: none;border-bottom: 1px solid #000;" value=${safeFormData.texts?.relationshipPlace || ''}>
                        </td>
                        <td align="right" valign="center" style="color: #404041;font-size: 14px;font-weight: 500;">
                           
                            Signature of Patient : ${safeFormData.texts?.relationshipSignature || ''}
                        </td>
                    </tr>
                    <tr>
                        <td colspan="2" align="right" valign="center" style="color: #404041;font-size: 14px;font-weight: 500;">
                            Name, Signature & Registration No.<br/>
of Gynaecologist/Medical Geneticist / Radiologist/<br/>
Pediatrician / Director of the Clinic / Center / Laboratory
                        </td>
                    </tr>
                    <tr>
                        <td colspan="2" align="right" valign="center" style="color: #404041;font-size: 14px;font-weight: 500;">
                            Name, Address& Registration No.<br/>
of Genetic Clinic / Institute [Seal]
                        </td>
                    </tr>
                    <tr>
                        <td height="20">&nbsp;</td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
    </body>
    </html>
        `;

    await page.setContent(htmlContent);
    // let zohoResult= await submitToZohoForms(htmlContent);
    // console.log('zohoResult',zohoResult);

    const fileName = `${(safeFormData.fullName || '').replace(/\s+/g, '_')}_test_requisition_${Date.now()}.pdf`;
    const filePath = path.join(uploadsDir, fileName);

    const pdfBuffer =await page.pdf({
      path: filePath,
      format: "A4",
      printBackground: true,
      margin: {
        top: "20px",
        right: "20px",
        bottom: "20px",
        left: "20px",
      },
    });

    await browser.close();
    
    try {
     await uploadToWorkDrive(pdfBuffer, fileName);
    res.download(filePath, fileName, (err) => {
      if (err) {
        console.error("Error downloading file:", err);
        res.status(500).send("Error downloading file");
      }

      // Delete file after sending
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) {
          console.error("Error deleting file:", unlinkErr);
        }
      });
    });
  } catch (error) {
    console.error("Error generating PDF:", error);
    res.status(500).json({ error: "Failed to generate PDF" });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
