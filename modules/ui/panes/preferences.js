import { t } from '../../core/localizer';
import { uiPane } from '../pane';
import {
  uiSectionBetteridAI,
  uiSectionBetteridEditing,
  uiSectionBetteridExperimental,
  uiSectionBetteridGeneral,
  uiSectionBetteridLanguage,
  uiSectionBetteridValidation
} from '../sections/betterid_preferences';
import { uiSectionPrivacy } from '../sections/privacy';

export function uiPanePreferences(context) {

  let preferencesPane = uiPane('preferences', context)
    .key(t('preferences.key'))
    .label(t.append('preferences.title'))
    .description(t.append('preferences.description'))
    .iconName('fas-user-cog')
    .sections([
        uiSectionBetteridGeneral(context),
        uiSectionBetteridEditing(context),
        uiSectionBetteridLanguage(context),
        uiSectionBetteridValidation(context),
        uiSectionBetteridAI(context),
        uiSectionBetteridExperimental(context),
        uiSectionPrivacy(context)
    ]);

  return preferencesPane;
}
