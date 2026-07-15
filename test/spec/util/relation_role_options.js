import { select as d3_select } from 'd3-selection';


describe('iD.utilRelationRoleOptions', function() {
    it('localizes common role labels without changing their OSM values', function() {
        var custom = { value: 'custom_role', title: 'custom_role' };
        var options = iD.utilRelationRoleOptions([
            { value: 'parking_space', title: 'parking_space' },
            custom
        ]);
        var label = d3_select(document.body)
            .append('span');

        options[0].display(label);

        expect(options[0].value).toBe('parking_space');
        expect(options[0].title).toBe('Parking Space (parking_space)');
        expect(options[0].terms).toContain('Parking Space');
        expect(label.text()).toBe('Parking Space');
        expect(options[1]).toBe(custom);

        label.remove();
    });
});
