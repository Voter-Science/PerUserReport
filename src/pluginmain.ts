// Show a per-user report.
// - # of people
// - # of households
// - # of completed surveys
// - # of hours.

import * as XC from 'trc-httpshim/xclient'
import * as common from 'trc-httpshim/common'

import * as core from 'trc-core/core'

import * as trcSheet from 'trc-sheet/sheet'
import * as trcSheetContents from 'trc-sheet/sheetContents'
import * as trcSheetEx from 'trc-sheet/sheetEx'

import * as plugin from 'trc-web/plugin'
import * as trchtml from 'trc-web/html'
import { HashCount } from './hashcount'


declare var $: any; // external definition for JQuery

// Provide easy error handle for reporting errors from promises.  Usage:
//   p.catch(showError);
declare var showError: (error: any) => void; // error handler defined in index.html
declare var google: any;

export class MyPlugin {
    private _sheet: trcSheet.SheetClient;
    private _pluginClient: plugin.PluginClient;

    private _sheetIndex: trcSheetContents.SheetContentsIndex;
    private _userInfoMap: any = {};

    public static BrowserEntryAsync(
        auth: plugin.IStart,
        opts: plugin.IPluginOptions
    ): Promise<MyPlugin> {

        var pluginClient = new plugin.PluginClient(auth, opts);

        // Do any IO here...

        var throwError = false; // $$$ remove this

        var plugin2 = new MyPlugin(pluginClient);
        return plugin2.InitAsync().then(() => {
            if (throwError) {
                throw "some error";
            }

            return plugin2;
        });
    }

    // Expose constructor directly for tests. They can pass in mock versions.
    public constructor(p: plugin.PluginClient) {
        this._sheet = new trcSheet.SheetClient(p.HttpClient, p.SheetId);
    }

    // Make initial network calls to setup the plugin.
    // Need this as a separate call from the ctor since ctors aren't async.
    private InitAsync(): Promise<void> {
        return this._sheet.getInfoAsync().then(info => {
            return this._sheet.getDeltaRangeAsync().then(iter => {
                return iter.ForEach(item => {
                    var user = item.User;

                    var userInfo: UserInfo = this.getUserInfo(user);

                    var clientTimestamp = false;

                    trcSheetContents.SheetContents.ForEach(item.Value, (recId, columnName, newValue) => {
                        // XLastModified, XLat, XLong
                        if (columnName == "XLastModified") {
                            clientTimestamp = true;
                            userInfo.RecordTime(newValue);
                        } else {
                            userInfo.Apply(recId, columnName);
                        }
                    });

                    if (!clientTimestamp) {
                        userInfo.RecordTime(item.Timestamp);
                    }

                    userInfo.GeoLatLng(item.GeoLat, item.GeoLong);

                });

            }).then(() => {
                return this._sheet.getSheetContentsAsync().then(contents => {
                    this._sheetIndex = new trcSheetContents.SheetContentsIndex(contents);
                }).catch( ()=> {
                    // No addresses available. Show stats based on deltas.
                    this._sheetIndex = null;
                });
            });
        }).then(() => {
            this.Render();
            this.initMap();
        });
    }

    private Render(): void {
        var root = $("#contents");

        var data: trcSheetContents.ISheetContents = {};

        var cUserName: string[] = [];
        var cVoters: string[] = [];
        var cDoors: string[] = [];
        var cCompleted: string[] = [];
        var cTime: string[] = [];
        var cLatLng = new Array();

        for (var i in this._userInfoMap) {
            var userInfo = <UserInfo>this._userInfoMap[i];
            cUserName.push(userInfo.getUserName());
            cVoters.push(userInfo.getCountVoters().toString());

            if (this._sheetIndex == null)
            {
                cDoors.push("n/a");
            } else {
                cDoors.push(userInfo.getCountHouseholds().toString());
            }
            cCompleted.push(userInfo.getCountSurveys().toString());

            var timeMinutes = Math.trunc(userInfo.getTotalTimeSeconds() / 60).toString();
            cTime.push(timeMinutes);
            cLatLng.push(userInfo.getLatLng());
        }

        data["User"] = cUserName;
        data["Completed"] = cCompleted;
        data["People"] = cVoters;
        data["Households"] = cDoors;
        data["Time (min)"] = cTime;

        var r = new trchtml.RenderSheet("contents", data);
        r.render();
    }

    private initMap(): void {

        var map = new google.maps.Map(document.getElementById('map'), {
          zoom: 8
        });

        for (var i in this._userInfoMap) {
            var randomColor = '#'+ ('000000' + Math.floor(Math.random()*16777215).toString(16)).slice(-6);
            var userInfo = <UserInfo>this._userInfoMap[i];
            var userName = userInfo.getUserName();

            var latLng = userInfo.getLatLng();

            var bounds  = new google.maps.LatLngBounds();

            for (let j: number = 0; j < latLng.length; j++)
            {
                var position = new google.maps.LatLng(latLng[j].lat, latLng[j].lng);

                bounds.extend(position);

            }

            var flightPath = new google.maps.Polyline({
                path: latLng,
                geodesic: true,
                strokeColor: randomColor,
                strokeOpacity: 1.0,
                strokeWeight: 3
            });
            flightPath.setMap(map);
        }

            var center = bounds.getCenter();
            map.setCenter(center);

      }

    private getUserInfo(user: string): UserInfo {
        var x = <UserInfo>this._userInfoMap[user];
        if (!x) {
            x = new UserInfo(user, this);
            this._userInfoMap[user] = x;
        }

        return x;
    }

    public GetAddress(recId: string): string {
        if (this._sheetIndex == null)
        {
            return "na";
        }
        var idx = this._sheetIndex.lookupRecId(recId);

        var addrColumn = this._sheetIndex.getContents()["Address"];
        var cityColumn = this._sheetIndex.getContents()["City"];
        return addrColumn[idx] + ", " + cityColumn[idx];
    }
}

class UserInfo {
    private _user: string;
    private _parent: MyPlugin;

    private _recIds: HashCount = new HashCount();
    private _households: HashCount = new HashCount();
    private _completedSurveys: HashCount = new HashCount();

    public constructor(user: string, parent: MyPlugin) {
        this._user = user;
        this._parent = parent;
    }

    private _totalTimeSeconds: number = 0;
    private _lastTime?: Date;

    private _latLng = new Array();

    //private _cord: any = {};

    public GeoLatLng(geoLat: string, geoLng: string): void {

        if ((geoLat != null) && (geoLng != null)) {

            var cord = { lat: parseFloat(geoLat), lng: parseFloat(geoLng) }

            this._latLng.push(cord);

        }
    }

    // Record timestamp. Assumes these are increasing order.
    public RecordTime(timestamp: string): void {
        if (!timestamp) {
            return;
        }
        var thresholdMs: number = 15 * 60 * 1000;

        var d = new Date(timestamp);
        if (this._lastTime) {
            var diffMS: number = d.getTime() - this._lastTime.getTime();

            if (diffMS < 0) {
                // Timestamps are received out of order.
                // $$$ should caller have sorted them?
                return;
            }

            if (diffMS > thresholdMs) {
                // New time is too far apart from previous time, assume there was a break.
                this._lastTime = null;
            } else {
                this._totalTimeSeconds += (diffMS / 1000);
            }
        }
        this._lastTime = d;
    }

    public Apply(recId: string, columnName: string): void {

        this._recIds.Add(recId);

        var address = this._parent.GetAddress(recId);
        this._households.Add(address);

        var x = columnName.toLowerCase();
        var isQuestion = (
            x != "party" &&
            x != "cellphone" &&
            x != "email" &&
            x != "resultofcontact" &&
            x != "comments" &&
            x[0] != 'x');  // exclude builtins like "XLat, XLong, XModified "


        if (isQuestion) {
            this._completedSurveys.Add(recId);
        }
    }

    public getUserName(): string {
        return this._user;
    }

    public getTotalTimeSeconds(): number {
        return this._totalTimeSeconds;
    }

    public getCountVoters(): number {
        return this._recIds.getCount();
    }

    public getCountHouseholds(): number {
        return this._households.getCount();
    }

    public getCountSurveys(): number {
        return this._completedSurveys.getCount();
    }

    public getLatLng(): any {
        return this._latLng;
    }
}
