// Parsed, never executed. Exercises every supported spelling and rejected escape.
import { t as gettext, plural as count } from '../../src/ui/i18n';
import * as messages from '../../src/ui/i18n';
gettext('single');
gettext("double");
messages.t(`template`);
count('one', 'many', 2);
messages.plural('first', 'others', 0);
gettext(`dynamic ${1}`);
const detached = gettext;
const { t } = messages;
messages['t']('computed');

