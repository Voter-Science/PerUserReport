interface IHashCount {
    [key: string]: boolean;
}

// A simple collection for counting unique items.
export class HashCount
{
    private _dict :  IHashCount = { };

    public Add(item: string) : void {
        this._dict[item] = true;
    }

    public getCount() : number {
        // https://stackoverflow.com/questions/8702219/how-to-get-javascript-hash-table-count
        return Object.keys(this._dict).length;
    }
}