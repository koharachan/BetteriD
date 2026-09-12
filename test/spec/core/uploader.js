import { fn } from '@vitest/spy';

describe('coreUploader', function() {
    let context;

    beforeEach(function() {
        context = iD.coreContext().assetPath('../dist/').init();
    });

    afterEach(function() {
        vi.useRealTimers();
    });

    describe('#privatelyUploaded', function() {
        it('reports a changeset that was uploaded outside the save pipeline', function() {
            const uploader = context.uploader();
            const willAttempt = fn();
            const succeeded = fn();
            const ended = fn();
            uploader
                .on('willAttemptUpload.test', willAttempt)
                .on('resultSuccess.test', succeeded)
                .on('saveEnded.test', ended);

            uploader.privatelyUploaded({ id: 188909307 });

            expect(willAttempt).toHaveBeenCalledOnce();
            expect(willAttempt.mock.calls[0][0]).toEqual({ id: 188909307 });
            expect(succeeded).toHaveBeenCalledOnce();
            expect(succeeded.mock.calls[0][0]).toEqual({ id: 188909307 });
            expect(ended).not.toHaveBeenCalled();   // deferred until the reset
        });

        it('clears the saved edits and resets the editor after the delay', async function() {
            const uploader = context.uploader();
            context.perform(iD.actionAddEntity(new iD.osmNode({ id: 'n-1', loc: [0, 0] })));
            expect(context.history().hasChanges()).toBe(true);

            vi.useFakeTimers();
            const ended = fn();
            uploader.on('saveEnded.test', ended);
            uploader.privatelyUploaded({ id: 12345 });

            await vi.advanceTimersByTimeAsync(2600);

            expect(ended).toHaveBeenCalledOnce();
            expect(context.history().hasChanges()).toBe(false);
            expect(context.history().difference().summary()).toHaveLength(0);
        });

        it('still resets the editor when a saveEnded listener throws', async function() {
            const uploader = context.uploader();
            context.perform(iD.actionAddEntity(new iD.osmNode({ id: 'n-1', loc: [0, 0] })));

            vi.useFakeTimers();
            uploader.on('saveEnded.test', function() {
                throw new Error('listener blew up');
            });
            uploader.privatelyUploaded({ id: 12345 });

            await expect(vi.advanceTimersByTimeAsync(2600)).rejects.toThrow('listener blew up');
            expect(context.history().hasChanges()).toBe(false);
        });
    });
});
