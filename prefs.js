import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class HFPropagationPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // Create a preferences page
        const page = new Adw.PreferencesPage({
            title: 'HF Propagation Settings',
            icon_name: 'network-wireless-symbolic'
        });
        window.add(page);

        // Create a preferences group
        const group = new Adw.PreferencesGroup({
            title: 'Display Settings',
            description: 'Configure how propagation data is displayed'
        });
        page.add(group);

        // Add a simple info row for now
        const infoRow = new Adw.ActionRow({
            title: 'HF Propagation Monitor',
            subtitle: 'Shows solar indices and band conditions for amateur radio'
        });
        group.add(infoRow);

        // Add update interval setting (example)
        const updateGroup = new Adw.PreferencesGroup({
            title: 'Update Settings'
        });
        page.add(updateGroup);

        const intervalRow = new Adw.ActionRow({
            title: 'Update Interval',
            subtitle: 'Currently updates every 5 minutes'
        });
        updateGroup.add(intervalRow);

        // Add about section
        const aboutGroup = new Adw.PreferencesGroup({
            title: 'About'
        });
        page.add(aboutGroup);

        const aboutRow = new Adw.ActionRow({
            title: 'Version',
            subtitle: '1.0 - Compatible with GNOME 45+'
        });
        aboutGroup.add(aboutRow);
    }
}
