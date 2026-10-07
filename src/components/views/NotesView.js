import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';
import { unifiedPageStyles } from './sharedPageStyles.js';
import './NotesPanel.js';

export class NotesView extends LitElement {
    static styles = [
        unifiedPageStyles,
        css`
            notes-panel {
                height: auto;
            }
        `,
    ];

    render() {
        return html`
            <div class="unified-page">
                <div class="unified-wrap">
                    <div>
                        <div class="page-title">Notes</div>
                        <div class="page-subtitle">
                            Keep your prep as short chunks: STAR stories, project talking points, formulas, questions to ask. Open them in the side
                            panel during a session with [notes]. Turn on "Share with AI" for chunks the AI should use in its answers.
                        </div>
                    </div>
                    <section class="surface">
                        <notes-panel></notes-panel>
                    </section>
                </div>
            </div>
        `;
    }
}

customElements.define('notes-view', NotesView);
