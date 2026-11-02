"""Format 1.5: same canonical fixture and version cases as ft-in-format.test.ts."""
import json
from pathlib import Path

import pytest

from fireplan import Plan, PlanError, VERSION_LATEST
from fireplan.serialize import required_version

FIXTURES = Path(__file__).resolve().parents[2] / 'fixtures'


def test_ft_in_fixture_and_version():
    text = (FIXTURES / 'ft-in.ftp.json').read_text(encoding='utf-8')
    plan = Plan.loads(text)
    assert plan.dumps() == text
    assert plan.display_length_unit == 'ft-in'
    assert required_version(plan.data) == '1.5.0'
    assert VERSION_LATEST == '1.6.0'
    plan.validate_schema()
    plan.validate_schema('1.5.0')
    with pytest.raises(PlanError, match='ft-in'):
        plan.validate_schema('1.4.0')
    plan.data['version'] = '1.0.0'
    assert any(i.code == 'version-understated' for i in plan.check())
    assert plan.dumps() == text
    plan.data['version'] = '2.0.0'
    assert json.loads(plan.dumps())['version'] == '2.0.0'


@pytest.mark.parametrize('unit', ['m', 'cm', 'mm', 'ft', 'in'])
def test_other_display_units_do_not_bump(unit):
    plan = Plan.new('units')
    plan.data['units']['display']['length'] = unit
    assert json.loads(plan.dumps())['version'] == '1.0.0'
    plan.data['units']['display']['length'] = 'ft-in'
    assert json.loads(plan.dumps())['version'] == '1.5.0'


@pytest.mark.parametrize('path', [
    'pool-fire-camera-row.ftp.json', 'flame/flame-test.ftp.json',
    'linked-files/linked-test.ftp.json', 'fds/room_corner.ftp.json',
])
def test_existing_fixtures_stay_identical(path):
    text = (FIXTURES / path).read_text(encoding='utf-8')
    assert Plan.loads(text).dumps() == text
