// HF Propagation – GNOME Shell extension entry point.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {HFIndicator, addIndicator} from './lib/indicator.js';

export default class HFPropagationExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._createIndicator();
        this._positionChangedId = this._settings.connect('changed::panel-position', () => {
            this._indicator?.destroy();
            this._createIndicator();
        });
    }

    _createIndicator() {
        this._indicator = new HFIndicator(this);
        addIndicator(this._indicator, this._settings.get_string('panel-position'));
    }

    disable() {
        if (this._positionChangedId) {
            this._settings.disconnect(this._positionChangedId);
            this._positionChangedId = 0;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
