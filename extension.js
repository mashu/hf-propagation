import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Real data sources
const DATA_SOURCES = {
    // NOAA Space Weather
    noaa_solar: 'https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json',
    noaa_planetary_k: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
    // HamQSL.com provides XML data - we'll parse it
    hamqsl: 'https://www.hamqsl.com/solarxml.php',
    // Alternative: N0NBH solar data
    n0nbh: 'https://www.hamqth.com/solarxml.php'
};

// Visual indicators using Unicode and emoji
const INDICATORS = {
    solar: {
        high: '☀️',
        medium: '🌤️',
        low: '☁️'
    },
    magnetic: {
        quiet: '🟢',
        unsettled: '🟡',
        active: '🟠',
        storm: '🔴'
    },
    bands: {
        excellent: '✨',
        good: '⭐',
        fair: '💫',
        poor: '🌫️'
    },
    arrows: {
        up: '↗️',
        down: '↘️',
        stable: '→'
    },
    signal: {
        strong: '📶',
        medium: '📳',
        weak: '📵'
    }
};

// Color schemes for modern look
const COLORS = {
    excellent: '#10b981', // emerald-500
    good: '#84cc16',      // lime-500
    fair: '#eab308',      // yellow-500
    poor: '#ef4444',      // red-500
    storm: '#dc2626',     // red-600
    quiet: '#22c55e',     // green-500
    background: 'rgba(30, 41, 59, 0.8)', // slate-800
    text: '#f1f5f9'       // slate-100
};

const HFIndicator = GObject.registerClass(
class HFIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'HF Propagation', false);
        
        console.log('[HF Propagation] HFIndicator _init() started');
        
        // Initialize data storage
        this._data = {
            sfi: null,
            k: null,
            a: null,
            sunspots: null,
            xray: null,
            protonFlux: null,
            bands: {},
            lastUpdate: null,
            trend: 'stable'
        };
        
        // HTTP Session for fetching data
        this._httpSession = null;
        this._setupHttpSession();
        
        // Create panel widget
        this._createPanelWidget();
        
        // Create menu
        this._createMenu();
        
        // Start data fetching
        this._fetchAllData();
        
        // Set up update timer (5 minutes)
        this._timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 300, () => {
            this._fetchAllData();
            return GLib.SOURCE_CONTINUE;
        });
    }
    
    _setupHttpSession() {
        this._httpSession = new Soup.Session({
            timeout: 10,
            user_agent: 'GNOME-HF-Propagation/1.0'
        });
    }
    
    _createPanelWidget() {
        // Main container
        this._panelBox = new St.BoxLayout({
            style_class: 'panel-button',
            reactive: true,
            can_focus: true,
            track_hover: true,
            style: 'spacing: 6px;'
        });
        
        // Solar indicator
        this._solarIcon = new St.Label({
            text: INDICATORS.solar.medium,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 14px;'
        });
        
        // SFI value
        this._sfiLabel = new St.Label({
            text: 'SFI: --',
            y_align: Clutter.ActorAlign.CENTER,
            style: `color: ${COLORS.text}; font-weight: bold;`
        });
        
        // K-index indicator
        this._kIcon = new St.Label({
            text: INDICATORS.magnetic.quiet,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 14px; padding-left: 6px;'
        });
        
        // K value
        this._kLabel = new St.Label({
            text: 'K: -',
            y_align: Clutter.ActorAlign.CENTER,
            style: `color: ${COLORS.text}; font-weight: bold;`
        });
        
        this._panelBox.add_child(this._solarIcon);
        this._panelBox.add_child(this._sfiLabel);
        this._panelBox.add_child(this._kIcon);
        this._panelBox.add_child(this._kLabel);
        
        this.add_child(this._panelBox);
    }
    
    _createMenu() {
        // Title with gradient background
        const titleItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        const titleBox = new St.BoxLayout({ 
            vertical: false,
            style: `padding: 12px; background: linear-gradient(135deg, ${COLORS.background}, rgba(15, 23, 42, 0.9)); border-radius: 8px;`
        });
        
        const titleIcon = new St.Label({
            text: '📡',
            style: 'font-size: 20px; padding-right: 8px;'
        });
        const titleLabel = new St.Label({
            text: 'HF Propagation Monitor',
            style: 'font-size: 16px; font-weight: bold; color: ' + COLORS.text
        });
        
        titleBox.add_child(titleIcon);
        titleBox.add_child(titleLabel);
        titleItem.actor.add_child(titleBox);
        this.menu.addMenuItem(titleItem);
        
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        
        // Solar indices section
        this._createSolarSection();
        
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        
        // Band conditions section
        this._createBandSection();
        
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        
        // Footer section
        this._createFooterSection();
    }
    
    _createSolarSection() {
        // Solar data container
        const solarTitle = new PopupMenu.PopupMenuItem('Solar Indices', { reactive: false });
        solarTitle.label.set_style('font-weight: bold; color: ' + COLORS.text);
        this.menu.addMenuItem(solarTitle);
        
        // SFI with visual bar
        this._sfiItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        const sfiContainer = new St.BoxLayout({ 
            vertical: true,
            style: 'padding: 8px;'
        });
        
        const sfiRow = new St.BoxLayout({ vertical: false });
        this._sfiIcon = new St.Label({ 
            text: INDICATORS.solar.medium,
            style: 'font-size: 18px; padding-right: 8px;'
        });
        this._sfiValueLabel = new St.Label({ 
            text: 'Solar Flux: --',
            style: 'font-weight: bold;'
        });
        this._sfiTrend = new St.Label({
            text: '',
            style: 'padding-left: 8px;'
        });
        
        sfiRow.add_child(this._sfiIcon);
        sfiRow.add_child(this._sfiValueLabel);
        sfiRow.add_child(this._sfiTrend);
        
        // Visual progress bar
        this._sfiBar = new St.DrawingArea({
            width: 300,
            height: 8,
            style: 'margin-top: 6px; border-radius: 4px; background: rgba(100, 116, 139, 0.2);'
        });
        this._sfiBar.connect('repaint', this._drawSFIBar.bind(this));
        
        sfiContainer.add_child(sfiRow);
        sfiContainer.add_child(this._sfiBar);
        this._sfiItem.actor.add_child(sfiContainer);
        this.menu.addMenuItem(this._sfiItem);
        
        // K-index with blocks
        this._kItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        const kContainer = new St.BoxLayout({ 
            vertical: true,
            style: 'padding: 8px;'
        });
        
        const kRow = new St.BoxLayout({ vertical: false });
        this._kIconDetail = new St.Label({ 
            text: INDICATORS.magnetic.quiet,
            style: 'font-size: 18px; padding-right: 8px;'
        });
        this._kValueLabel = new St.Label({ 
            text: 'K-Index: --',
            style: 'font-weight: bold;'
        });
        this._kDescription = new St.Label({
            text: '',
            style: 'padding-left: 8px; font-style: italic;'
        });
        
        kRow.add_child(this._kIconDetail);
        kRow.add_child(this._kValueLabel);
        kRow.add_child(this._kDescription);
        
        // K-index visual blocks
        this._kBlockContainer = new St.BoxLayout({
            style: 'margin-top: 6px; spacing: 2px;'
        });
        this._kBlocks = [];
        for (let i = 0; i < 9; i++) {
            const block = new St.Widget({
                width: 30,
                height: 10,
                style: 'border-radius: 2px; background: rgba(100, 116, 139, 0.2);'
            });
            this._kBlockContainer.add_child(block);
            this._kBlocks.push(block);
        }
        
        kContainer.add_child(kRow);
        kContainer.add_child(this._kBlockContainer);
        this._kItem.actor.add_child(kContainer);
        this.menu.addMenuItem(this._kItem);
        
        // A-index
        this._aItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        this._aItem.label.set_text('🧲 A-Index: --');
        this.menu.addMenuItem(this._aItem);
        
        // Sunspots
        this._sunspotItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        this._sunspotItem.label.set_text('🌑 Sunspot Number: --');
        this.menu.addMenuItem(this._sunspotItem);
        
        // X-ray flux
        this._xrayItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        this._xrayItem.label.set_text('☢️ X-Ray Flux: --');
        this.menu.addMenuItem(this._xrayItem);
    }
    
    _createBandSection() {
        const bandTitle = new PopupMenu.PopupMenuItem('Band Conditions', { reactive: false });
        bandTitle.label.set_style('font-weight: bold; color: ' + COLORS.text);
        this.menu.addMenuItem(bandTitle);
        
        const bands = ['160m', '80m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m'];
        this._bandItems = {};
        
        bands.forEach(band => {
            const item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
            const container = new St.BoxLayout({
                vertical: false,
                style: 'padding: 4px 8px;'
            });
            
            // Band name
            const bandLabel = new St.Label({
                text: band,
                style: 'width: 45px; font-weight: bold;'
            });
            
            // Condition icon
            const conditionIcon = new St.Label({
                text: INDICATORS.bands.fair,
                style: 'font-size: 16px; padding: 0 8px;'
            });
            
            // Visual bar
            const bar = new St.Widget({
                width: 120,
                height: 12,
                style: 'border-radius: 6px; background: rgba(100, 116, 139, 0.2);'
            });
            
            // Status text
            const statusLabel = new St.Label({
                text: 'Loading...',
                style: 'padding-left: 8px; font-size: 12px;'
            });
            
            // Signal strength
            const signalIcon = new St.Label({
                text: INDICATORS.signal.medium,
                style: 'padding-left: 8px;'
            });
            
            container.add_child(bandLabel);
            container.add_child(conditionIcon);
            container.add_child(bar);
            container.add_child(statusLabel);
            container.add_child(signalIcon);
            
            item.actor.add_child(container);
            this.menu.addMenuItem(item);
            
            this._bandItems[band] = {
                item: item,
                icon: conditionIcon,
                bar: bar,
                status: statusLabel,
                signal: signalIcon
            };
        });
    }
    
    _createFooterSection() {
        // Update time
        this._updateTimeItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        this._updateTimeItem.label.set_style('font-size: 11px; font-style: italic;');
        this.menu.addMenuItem(this._updateTimeItem);
        
        // Refresh button
        const refreshItem = new PopupMenu.PopupMenuItem('');
        const refreshBox = new St.BoxLayout({ vertical: false });
        const refreshIcon = new St.Label({ 
            text: '🔄',
            style: 'padding-right: 6px;'
        });
        const refreshLabel = new St.Label({ text: 'Refresh Now' });
        refreshBox.add_child(refreshIcon);
        refreshBox.add_child(refreshLabel);
        refreshItem.actor.add_child(refreshBox);
        
        refreshItem.connect('activate', () => {
            this._fetchAllData();
        });
        this.menu.addMenuItem(refreshItem);
        
        // Data source credit
        const creditItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        creditItem.label.set_text('📊 Data: NOAA SWPC & HamQSL');
        creditItem.label.set_style('font-size: 10px; opacity: 0.7;');
        this.menu.addMenuItem(creditItem);
    }
    
    _drawSFIBar(area) {
        const [width, height] = area.get_surface_size();
        const cr = area.get_context();
        
        if (this._data.sfi) {
            // SFI ranges from ~60 to 300
            const normalized = Math.min(1.0, Math.max(0, (this._data.sfi - 60) / 240));
            
            // Gradient based on value - convert hex to RGB
            let r, g, b;
            let colorHex;
            if (this._data.sfi < 80) {
                colorHex = COLORS.poor;
            } else if (this._data.sfi < 120) {
                colorHex = COLORS.fair;
            } else if (this._data.sfi < 160) {
                colorHex = COLORS.good;
            } else {
                colorHex = COLORS.excellent;
            }
            
            // Convert hex to RGB
            const hex = colorHex.replace('#', '');
            r = parseInt(hex.substring(0, 2), 16) / 255;
            g = parseInt(hex.substring(2, 4), 16) / 255;
            b = parseInt(hex.substring(4, 6), 16) / 255;
            
            // Draw filled portion
            cr.setSourceRGBA(r, g, b, 0.8);
            cr.rectangle(0, 0, width * normalized, height);
            cr.fill();
        }
        
        cr.$dispose();
    }
    
    _updateKIndexBlocks(k) {
        this._kBlocks.forEach((block, i) => {
            if (i < k) {
                let color;
                if (k <= 3) color = COLORS.quiet;
                else if (k <= 5) color = COLORS.fair;
                else if (k <= 7) color = COLORS.poor;
                else color = COLORS.storm;
                
                block.set_style(`
                    border-radius: 2px;
                    background: ${color};
                    box-shadow: 0 0 4px ${color}40;
                `);
            } else {
                block.set_style('border-radius: 2px; background: rgba(100, 116, 139, 0.2);');
            }
        });
    }
    
    _fetchAllData() {
        console.log('[HF Propagation] _fetchAllData() called');
        // Fetch from NOAA
        this._fetchNOAAData();
        // Fetch from HamQSL for band conditions
        this._fetchHamQSLData();
    }
    
    _fetchNOAAData() {
        // Fetch latest solar indices
        console.log('[HF Propagation] Fetching NOAA solar data from:', DATA_SOURCES.noaa_solar);
        const message = Soup.Message.new('GET', DATA_SOURCES.noaa_solar);
        
        this._httpSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                console.log('[HF Propagation] NOAA solar data callback triggered');
                try {
                    const bytes = session.send_and_read_finish(result);
                    const decoder = new TextDecoder('utf-8');
                    const text = decoder.decode(bytes.get_data());
                    const data = JSON.parse(text);
                    
                    if (data && data.length > 0) {
                        // Get the most recent entry
                        const latest = data[data.length - 1];
                        const previous = data.length > 1 ? data[data.length - 2] : null;
                        
                        this._data.sfi = latest.f10_7 || latest.solar_flux || null;
                        this._data.sunspots = latest.sunspot_number || null;
                        
                        console.log(`[HF Propagation] NOAA Solar data: SFI=${this._data.sfi}, Sunspots=${this._data.sunspots}`);
                        
                        // Calculate trend
                        if (previous && previous.f10_7) {
                            const diff = this._data.sfi - previous.f10_7;
                            this._data.trend = diff > 2 ? 'up' : diff < -2 ? 'down' : 'stable';
                        }
                        
                        this._calculateBandConditions();
                        this._updateAllDisplays();
                    }
                } catch (e) {
                    console.error('[HF Propagation] Error parsing NOAA solar data:', e);
                }
            }
        );
        
        // Fetch K-index
        console.log('[HF Propagation] Fetching NOAA K-index data from:', DATA_SOURCES.noaa_planetary_k);
        const kMessage = Soup.Message.new('GET', DATA_SOURCES.noaa_planetary_k);
        
        this._httpSession.send_and_read_async(
            kMessage,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                console.log('[HF Propagation] NOAA K-index callback triggered');
                try {
                    const bytes = session.send_and_read_finish(result);
                    const decoder = new TextDecoder('utf-8');
                    const text = decoder.decode(bytes.get_data());
                    const data = JSON.parse(text);
                    
                    if (data && data.length > 0) {
                        // Get the most recent K-index
                        const latest = data[data.length - 1];
                        this._data.k = parseInt(latest[1]) || 0;
                        this._data.a = latest[2] || null;
                        
                        console.log(`[HF Propagation] NOAA K-index data: K=${this._data.k}, A=${this._data.a}`);
                        
                        this._calculateBandConditions();
                        this._updateAllDisplays();
                    }
                } catch (e) {
                    console.error('[HF Propagation] Error parsing NOAA K-index:', e);
                }
            }
        );
    }
    
    _fetchHamQSLData() {
        console.log('[HF Propagation] Fetching HamQSL data from:', DATA_SOURCES.hamqsl);
        const message = Soup.Message.new('GET', DATA_SOURCES.hamqsl);
        
        this._httpSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                console.log('[HF Propagation] HamQSL callback triggered');
                try {
                    const bytes = session.send_and_read_finish(result);
                    const decoder = new TextDecoder('utf-8');
                    const xml = decoder.decode(bytes.get_data());
                    
                    // Parse XML manually (simple extraction)
                    this._parseHamQSLXML(xml);
                    
                } catch (e) {
                    console.error('[HF Propagation] Error fetching HamQSL data:', e);
                    // Fall back to calculated conditions
                    this._calculateBandConditions();
                }
            }
        );
    }
    
    _parseHamQSLXML(xml) {
        // Extract band conditions from XML
        const bands = {
            '80m-40m': { day: null, night: null },
            '30m-20m': { day: null, night: null },
            '17m-15m': { day: null, night: null },
            '12m-10m': { day: null, night: null }
        };
        
        // Simple XML parsing for band conditions
        const extract = (tag) => {
            const regex = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i');
            const match = xml.match(regex);
            return match ? match[1].trim() : null;
        };
        
        // Extract solar data if available
        const solarflux = extract('solarflux');
        if (solarflux) {
            this._data.sfi = parseInt(solarflux);
        }
        
        const aindex = extract('aindex');
        if (aindex) {
            this._data.a = parseInt(aindex);
        }
        
        const kindex = extract('kindex');
        if (kindex) {
            this._data.k = parseInt(kindex);
        }
        
        const sunspots = extract('sunspots');
        if (sunspots) {
            this._data.sunspots = parseInt(sunspots);
        }
        
        const xray = extract('xray');
        if (xray) {
            this._data.xray = xray;
        }
        
        const protonflux = extract('protonflux');
        if (protonflux) {
            this._data.protonFlux = protonflux;
        }
        
        console.log(`[HF Propagation] HamQSL data: SFI=${this._data.sfi}, K=${this._data.k}, A=${this._data.a}, Sunspots=${this._data.sunspots}, X-ray=${this._data.xray}`);
        
        // Extract band conditions
        const bandConditions = extract('calculatedconditions');
        const bandVHF = extract('calculatedvhfconditions');
        
        // Parse and apply band conditions
        this._calculateBandConditions();
        this._updateAllDisplays();
    }
    
    _calculateBandConditions() {
        if (!this._data.sfi || this._data.k === null) return;
        
        const bands = ['160m', '80m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m'];
        
        bands.forEach(band => {
            let score = (this._data.sfi / 25) - (this._data.k * 0.5);
            
            // Band-specific adjustments based on propagation physics
            switch(band) {
                case '160m':
                    score = this._data.k < 3 ? score - 1 : score - 3;
                    break;
                case '80m':
                    score = this._data.k < 4 ? score : score - 2;
                    break;
                case '40m':
                    score = this._data.k < 5 ? score + 0.5 : score - 1;
                    break;
                case '30m':
                    score = this._data.sfi > 80 ? score + 1 : score;
                    break;
                case '20m':
                    score = this._data.sfi > 90 ? score + 1.5 : score;
                    break;
                case '17m':
                    score = this._data.sfi > 100 ? score + 2 : score - 1;
                    break;
                case '15m':
                    score = this._data.sfi > 120 ? score + 2 : score - 2;
                    break;
                case '12m':
                    score = this._data.sfi > 130 ? score + 2.5 : score - 3;
                    break;
                case '10m':
                    score = this._data.sfi > 150 && this._data.k < 3 ? score + 3 : score - 4;
                    break;
                case '6m':
                    // 6m needs very high SFI and low K
                    score = this._data.sfi > 170 && this._data.k < 2 ? score + 2 : score - 5;
                    break;
            }
            
            let condition, color, icon, signal;
            if (score > 6) {
                condition = 'Excellent';
                color = COLORS.excellent;
                icon = INDICATORS.bands.excellent;
                signal = INDICATORS.signal.strong;
            } else if (score > 4) {
                condition = 'Good';
                color = COLORS.good;
                icon = INDICATORS.bands.good;
                signal = INDICATORS.signal.strong;
            } else if (score > 2) {
                condition = 'Fair';
                color = COLORS.fair;
                icon = INDICATORS.bands.fair;
                signal = INDICATORS.signal.medium;
            } else {
                condition = 'Poor';
                color = COLORS.poor;
                icon = INDICATORS.bands.poor;
                signal = INDICATORS.signal.weak;
            }
            
            this._data.bands[band] = { condition, color, icon, signal };
            
            // Update display
            if (this._bandItems[band]) {
                const item = this._bandItems[band];
                item.icon.set_text(icon);
                item.status.set_text(condition);
                item.signal.set_text(signal);
                item.bar.set_style(`
                    border-radius: 6px;
                    background: ${color};
                    box-shadow: 0 0 8px ${color}40;
                `);
            }
        });
    }
    
    _updateSolarDisplay() {
        if (this._data.sfi) {
            // Update panel
            this._sfiLabel.set_text(`SFI: ${this._data.sfi}`);
            
            // Update icon based on SFI value
            let icon;
            if (this._data.sfi < 100) {
                icon = INDICATORS.solar.low;
            } else if (this._data.sfi < 150) {
                icon = INDICATORS.solar.medium;
            } else {
                icon = INDICATORS.solar.high;
            }
            this._solarIcon.set_text(icon);
            
            // Update menu
            this._sfiValueLabel.set_text(`Solar Flux: ${this._data.sfi}`);
            this._sfiIcon.set_text(icon);
            
            // Update trend
            const trendIcon = INDICATORS.arrows[this._data.trend || 'stable'];
            this._sfiTrend.set_text(trendIcon);
            
            // Redraw bar
            this._sfiBar.queue_repaint();
        }
        
        if (this._data.sunspots !== null) {
            this._sunspotItem.label.set_text(`🌑 Sunspot Number: ${this._data.sunspots}`);
        }
        
        if (this._data.xray) {
            this._xrayItem.label.set_text(`☢️ X-Ray Flux: ${this._data.xray}`);
        }
    }
    
    _updateMagneticDisplay() {
        if (this._data.k !== null) {
            // Update panel
            this._kLabel.set_text(`K: ${this._data.k}`);
            
            // Update icon based on K value
            let icon, description;
            if (this._data.k <= 2) {
                icon = INDICATORS.magnetic.quiet;
                description = 'Quiet';
            } else if (this._data.k <= 4) {
                icon = INDICATORS.magnetic.unsettled;
                description = 'Unsettled';
            } else if (this._data.k <= 6) {
                icon = INDICATORS.magnetic.active;
                description = 'Active';
            } else {
                icon = INDICATORS.magnetic.storm;
                description = 'Storm!';
            }
            
            this._kIcon.set_text(icon);
            
            // Update menu
            this._kValueLabel.set_text(`K-Index: ${this._data.k}`);
            this._kIconDetail.set_text(icon);
            this._kDescription.set_text(description);
            
            // Update blocks
            this._updateKIndexBlocks(this._data.k);
        }
        
        if (this._data.a !== null) {
            this._aItem.label.set_text(`A-Index: ${this._data.a}`);
        }
    }
    
    _updateAllDisplays() {
        this._updateSolarDisplay();
        this._updateMagneticDisplay();
        
        // Update timestamp
        const now = new Date();
        this._data.lastUpdate = now;
        this._updateTimeItem.label.set_text(`🕒 Updated: ${now.toLocaleTimeString()}`);
    }
    
    destroy() {
        if (this._timeout) {
            GLib.source_remove(this._timeout);
            this._timeout = null;
        }
        if (this._httpSession) {
            this._httpSession = null;
        }
        super.destroy();
    }
});

export default class HFPropagationExtension {
    constructor() {
        this._indicator = null;
    }
    
    enable() {
        try {
            console.log('[HF Propagation] Extension enable() starting...');
            this._indicator = new HFIndicator();
            console.log('[HF Propagation] HFIndicator created');
            Main.panel.addToStatusArea('hf-propagation-indicator', this._indicator);
            console.log('[HF Propagation] Extension enabled - fetching real data from NOAA & HamQSL');
        } catch (e) {
            console.error('[HF Propagation] Error in enable():', e, e.stack);
        }
    }
    
    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        console.log('[HF Propagation] Extension disabled');
    }
}
