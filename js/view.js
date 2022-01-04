(function () {
    var bgPage;
    chrome.runtime.getBackgroundPage(function (ref) {
        bgPage = ref;
        bgPage.toggleAuth(true, function () {
            startup();
        });
    });

    function fontHandler(e) {
        ga('send', 'event', 'Button', 'Change Font');
        changeFont(this.form, this.value);
    }

    function orientHandler(e) {
        ga('send', 'event', 'Button', 'Change Orientation');
        changeOrient(this.form, this.value);
    }

    function printHandler(e) {
        ga('send', 'event', 'Button', 'Print Stickies');
        printDocumentPage();
        return false;
    }

    function cancelHandler(e) {
        console.log('close window');
        ga('send', 'event', 'Button', 'Cancel Print');
        window.open('', '_self', ''); //bug fix. This is a hack and may not be future proof. Works by crashing window.open?
        window.close();
        return false;
    }

    function templateHandler(e) {
        ga('send', 'event', 'Button', 'Print Template');
        openTemplate();
        return false;
    }

    //Listeners
    document.addEventListener('DOMContentLoaded', function () {
        document.querySelector('#typed').addEventListener('change', fontHandler);
        document.querySelector('#hand').addEventListener('change', fontHandler);
        document.querySelector('#landscape').addEventListener('change', orientHandler);
        document.querySelector('#portrait').addEventListener('change', orientHandler);
        document.querySelector('#cancel-button').addEventListener('click', cancelHandler);
        document.querySelector('#template-button').addEventListener('click', templateHandler);
    });
    /////////////////////////////////////////////////////////////////////////////////////
    //Global variables.
    var SPREAD_SCOPE = 'https://spreadsheets.google.com/feeds';
    var docKey; //The doc key for the document to print.
    var title; //The doc title to print
    var rows = [];

    function renderCallback(container, pages, callback) {
        console.log('renderCallback', container, pages, callback);
        //Loads the right number in to the controlbar.

        document.title = 'Citable - ' + title;

        setTotal(pages);
        var output = document.getElementById('output');
        if (output.hasChildNodes()) {
            output.replaceChild(container, output.firstChild);
        } else {
            output.appendChild(container);
        }
        document.querySelector('#loading').classList.add('hidden'); //Hide the loading gif.
        document.querySelector('#print-button').addEventListener('click', printHandler);
        document.querySelector('#print-button').disabled = false;
        console.timeEnd('renderNotes timer');

        makeDraggable(setTotal);

        if (callback) {
            callback();
        }
    }

    function renderNotes(rows, callback) {
        console.log('renderNotes()');
        render(rows, docKey, renderCallback, callback);
    }

    //Sets the helper text in the control bar to display the total number of pages.
    function setTotal(pages) {
        //if(num){ pages = num; }
        console.log('Set total: ', pages);
        var total = "<span class='Droid regular'>Total: </span><span class='Droid bold'>" + pages + " sheets of stickies</span>";
        document.getElementById('total').innerHTML = total;
    }

    //TODO: Create a new function to update the spreadsheet contents based on the changes
    // Persistent click handler for changing the title of a document.
    /*
    $('[contenteditable="true"]').live('blur', function(index) {
      var index = $(this).parent().attr('data-index');
      // Only make the XHR if the user chose a new title.
      //if ($(this).text() != bgPage.docs[index].title) {
      var r = rows[index];
      if ($(this).text() != rows[index]['title']) {
      	console.log('old title: ',rows[index]['title'],' new title: ',$(this).text(),' original title: ',rows[index].title);


    	//bgPage.r[index].title = $(this).text(); //ok

    	//gdocs.updateDoc(bgPage.docs[index]);
      }
    }); */

    //Prints this page. Doesn't work if it is clicked too often in a period of time. Use Command+P instead.
    function printDocumentPage(callback) {
        console.log('open print dialog');
        window.print();
        console.log('done printing');
        //chrome.tabs.create({ 'url' : 'print.html'});
        if (callback) {
            callback();
        }
    }

    //Opens a new tab that prints a template.
    function openTemplate() {
        var onStorage = function (items) {
            console.log('openTemplate.onStorage', items);
            if (items.orientation == 'portrait') {
                console.log('Open portrait template, ', items.orientation);
                chrome.tabs.create({
                    'url': 'template-portrait.html'
                });
            } else {
                console.log('Open landscape template, ', items.orientation);
                chrome.tabs.create({
                    'url': 'template-landscape.html'
                });
            }
        };
        chrome.storage.local.get('orientation', onStorage);
    }

    //Changes which font is used.
    function changeFont(formName, elementName) {
        console.log('changeFont() ', elementName);
        //Caches the font value;
        chrome.storage.local.set({
            'font': elementName
        });

        if (elementName == 'Droid') {
            console.log('toggle to Droid');
            document.querySelectorAll('.summary, .title, .author, .url, .tags, .fontIcon').forEach((item) => {
                item.classList.toggle('handwritten');
                item.classList.toggle('Droid');
            });
        } else {
            console.log('toggle to handwritten');
            document.querySelectorAll('.summary, .title, .author, .url, .tags, .fontIcon').forEach((item) => {
                item.classList.toggle('handwritten');
                item.classList.toggle('Droid');
            });
        }
        return;
    }

    //Changes the orientation of the page.
    function changeOrient(aForm, aValue) {
        console.log('changeOrient() ', aValue);
        //Saves the orientation setting in localStorage.
        chrome.storage.local.set({
            'orientation': aValue
        });

        if (aValue == 'portrait') {
            console.log('toggle to portrait');
            document.querySelectorAll('.page, .loading').forEach((item) => {
                item.classList.toggle('landscape');
                item.classList.toggle('portrait');
            });
            document.querySelectorAll('.landscapeIcon, .portraitIcon').forEach((item) => {
                item.classList.toggle('hidden');
            });
            //toggleCSS(1,noteOrderCSS);
            toggleCSS(1);
            // bgPage.resizeWindow('printable', 1200, 1110);
        } else {
            console.log('toggle to landscape');
            document.querySelectorAll('.page, .loading').forEach((item) => {
                item.classList.toggle('landscape');
                item.classList.toggle('portrait');
            });
            document.querySelectorAll('.landscapeIcon, .portraitIcon').forEach((item) => {
                item.classList.toggle('hidden');
            });
            toggleCSS(0);
            // bgPage.resizeWindow('printable', 1440, 900);
        }
    }

    //Changes the template.
    function changeTemplate(aForm, aValue) {
        console.log('changeTemplate() ', aValue);
        chrome.storage.local.set({
            'm': aValue
        });

        if (aValue == true) {
            document.querySelectorAll('.page').forEach((item) => {
                item.classList.add('m');
            });
            document.querySelector('#template-button').disabled = true;
        } else {
            document.querySelectorAll('.page').forEach((item) => {
                item.classList.remove('m');
            });
            document.querySelector('#template-button').disabled = false;
        }
    }

    //Generic function that intializes the form to match the previous settings stored in localStorage.
    function initRadio(value, key, formName, elementName, callback) {
        console.log('initRadio() ', value);
        if (value) {
            if (value == key) {
                console.log('Default');
                document.forms[formName].elements[elementName][0].checked = true;
                if (callback) {
                    callback(0);
                }
            } else {
                console.log('Not Default');
                document.forms[formName].elements[elementName][1].checked = true;
                if (callback) {
                    callback(1);
                }
            }
        } else {
            console.log('Initialize');
            document.forms[formName].elements[elementName][0].checked = true;
            if (callback) {
                callback(0);
            }
        }
    }

    function initCheck(value, key, formName, elementName, callback) {
        console.log('initCheck() ', value);
        if (value) {
            value = (value == 'true');
            console.log(value, key, value == key);
            if (value == key) {
                console.log('Default');
                document.forms[formName].elements[elementName].checked = value;
                if (callback) {
                    callback(value);
                }
            } else {
                console.log('Not Default');
                document.forms[formName].elements[elementName].checked = value;
                if (callback) {
                    callback(value);
                }
            }
        } else {
            console.log('Initialize');
            document.forms[formName].elements[elementName].checked = key;
            //$('#'+elementName).prop("checked", key);
            if (callback) {
                callback(key);
            }
        }
    }

    //Toggles on and off the landscape and portrait CSS sheets to set the page orientation when printing.
    function toggleCSS(dir, callback) {
        console.log('toggleCSS() ', dir);
        switch (dir) {
            case 0: //landscape
                chrome.storage.local.set({
                    'orientation': 'landscape'
                });
                //Toggles which @Page css sheet is used.
                document.styleSheets[0].disabled = false; //TODO: what is a faster way to handle this. Could save a couple seconds.
                document.styleSheets[1].disabled = true;
                //Toggles the visibility of the helper icons in the control bar.
                document.querySelectorAll('.landscapeIcon').forEach((item) => {
                    item.classList.remove('hidden');
                });
                document.querySelectorAll('.portraitIcon').forEach((item) => {
                    item.classList.add('hidden');
                });
                break;
            case 1: //portrait
                chrome.storage.local.set({
                    'orientation': 'portrait'
                });
                //Toggles which @Page css sheet is used.
                document.styleSheets[1].disabled = false;
                document.styleSheets[0].disabled = true;
                //Toggles the visibility of the helper icons in the control bar.
                document.querySelectorAll('.landscapeIcon').forEach((item) => {
                    item.classList.add('hidden');
                });
                document.querySelectorAll('.portraitIcon').forEach((item) => {
                    item.classList.remove('hidden');
                });
                break;
        }

        if (callback) {
            callback(dir);
        }
    }
    ///////////////////////////
    //No Longer Used
    ///////////////////////////
    function noteOrderCSS(dir) {
        //Removes the note placement classes in preparation for changing them.
        document.querySelectorAll('.note_wrapper').forEach((item) => {
            item.classList.remove('left', 'middle', 'right');
        });
        switch (dir) {
            case 0: //landscape
                //Changes the classes of the notes for display purposes.
                document.querySelectorAll('.note_wrapper').forEach((item, index) => {
                    var className = index % 3 == 0 ? "left" : (index % 3 == 1 ? "middle" : "right");
                    //Instead use columns(2 or 3), such that 'return index%col==0 ? "left" : (index%col==1 ? "middle" : "right");'
                    //The middle class may need to be rewritten.
                    item.classList.add(className);
                });
                break;
            case 1: //portrait
                //Changes the classes of the notes for display purposes.
                document.querySelectorAll('.note_wrapper').forEach((item, index) => {
                    var className = index % 2 == 0 ? "left" : "right";
                    item.classList.add(className);
                });
                break;
        }
    }

    //Changes the font used in the helper icon in the control bar.
    function setFontIcon(dir) {
        if (dir == 0) {
            chrome.storage.local.set({
                'font': 'Droid'
            });
        } else {
            chrome.storage.local.set({
                'font': 'handwritten'
            });
        }

        chrome.storage.local.get('font', function (items) {
            document.querySelector('.fontIcon').classList.add(items.font);
        });
    }

    function setTemplate(dir) {
        console.log('setTemplate() ', dir);
        if (dir == true) {
            document.querySelector('.page').classList.add('m');
            document.querySelector('#template-button').disabled = true;
            console.log('addClass');
        } else {
            console.log('removeClass');
        }
    }

    function changeAction(formName, formValue, rows) {
        console.time('loading timer');

        var handleResponse = function (items) {
            console.log('changeAction.onStorage', formName, formValue, rows, items);
            document.querySelector('#loading').classList.remove('hidden');
            var valuesArray = items[docKey];
            var i = parseInt(formName.substr(5, 1));

            valuesArray[i] = formValue;
            var obj = {};
            obj[docKey] = valuesArray;
            chrome.storage.local.set(obj);

            setTimeout(function () {
                console.time('renderNotes timer');
                renderNotes(rows, timerEnd);
            }, 0);

            var timerEnd = function () {
                console.timeEnd('loading timer');
            };
        };

        chrome.storage.local.get(docKey, handleResponse);
    }

    function parseURLParams(url) {
        var queryStart = url.indexOf("?") + 1;
        var queryEnd = url.indexOf("#") + 1 || url.length + 1;
        var query = url.slice(queryStart, queryEnd - 1);

        if (query === url || query === "") return;

        var params = {};
        var nvPairs = query.replace(/\+/g, " ").split("&");

        for (var i = 0; i < nvPairs.length; i++) {
            var nv = nvPairs[i].split("=");
            var n = decodeURIComponent(nv[0]);
            var v = decodeURIComponent(nv[1]);
            if (!(n in params)) {
                params[n] = [];
            }
            params[n].push(nv.length === 2 ? v : null);
        }
        return params;
    }

    //Callback after creating the document menu.
    // function getDocId() {
    //   console.log('getDocId()');
    //   if (document.querySelectorAll('#destination').length) {
    //     //Menu exists-> load document.
    //     console.log('Document menu exists');
    //     //TODO: fix this
    //     // docKey = $('#destination').val();
    //     console.log('docKey: ', docKey);
    //     printexport.gdocs.printDocument(null, processRowsCallback); //In printexport.js
    //   } else {
    //     //Menu does not exist-> redirect to Drive.
    //     console.log('No document menu.');
    //     //$('#loading').addClass('hidden'); //Hide the loading gif.
    //     document.querySelector('#loading').innerHTML = ('Try printing directly from a spreadsheet in <a href="https://drive.google.com">Google Drive</a>.');
    //   }
    // }

    //TODO: Can we remove the redundant variable 'row' and improve efficiency with explicit passing?

    //IMPORTANT TODO: Rewrite the whole process around a function queue, thus on changeAction will clear the queue and start over. BIG project. Is it possible to abort functions midway without explicitly checking for a flag?
    /*------------------------------------------------------------------------------------------*/
    function processRowsCallback(rows) {
        // rows = row; //From printexport.js
        console.log('processRowsCallback()', rows);

        //Parse column names.
        var cols = [];
        for (var key in rows[0]) {
            if (rows[0].hasOwnProperty(key)) {
                cols.push(key);
            }
        }
        console.log('Cols: ', cols);

        //Set the default field names
        var defaultFields = ['field0', 'field1', 'field2', 'field3', 'field4'];
        var defaultColumns = ['summary', 'title', 'author', 'url', 'tags'];


        //Build the select controls
        buildSelect(cols, defaultFields);


        //Initialize the select control values
        function initSelects() {
            function handleResponse(response) {
                console.log('get local storage', response);
                var valuesArray = [];
                for (var i = 0; i < 5; i++) {
                    valuesArray.push(initSelect(i, cols, defaultFields, defaultColumns, response));
                }
                var obj = {};
                obj[docKey] = valuesArray;
                chrome.storage.local.set(obj, function (r) {
                    console.log(r);
                });
            }
            chrome.storage.local.get(docKey, function (response) {
                handleResponse(response);
            });
        }

        function onSet() {

            //console.log(localStor.get(''));
            //Init CSS
            var onStorage = function (items) {
                console.log('processRowsCallback.onStorage', items);
                toggleCSS((items.orientation == 'portrait' ? 1 : 0)); //Important: No callback defined.
                //1 sec
                console.time('renderNotes timer');
                //renderNotes(makeSortable); //makeSortable >2sec
                renderNotes(rows);
                //renderNotes(makeDraggable);
            };

            chrome.storage.local.get('orientation', onStorage);
        }

        // chrome.storage.local.set({[docKey] : defaultColumns}, onSet);
        initSelects();
        onSet();
    }

    /*------------------------------------------------------------------------------------------*/
    //Render select controls.
    function buildSelect(cols, defaultFields, callback) {
        console.log('buildSelect()');
        var html = [];
        for (var col in cols) {
            html.push('<option value="', cols[col], '">', capitalize(cols[col]), '</option>');
        }
        //TODO: Change this to i<defaultFields.length for a fully generalized function.
        var valuesArray = [];
        for (var i = 0; i < 5; i++) {
            var j = (i == 2 || i == 3) ? 'split' : 'full';
            var name = "field" + i;
            var div = document.createElement('div');
            div.innerHTML = ('<label for="' + name + '" class="visuallyhidden" id="' + name + '_label">Area ' + (parseInt(i) + 1) + '</label><select id="' + name + '" aria-labelledby="' + name + '_label" class="Droid select ' + j + '" name="' + name + '" ><option value="none">None</option>' + html.join('') + '</select>');
            div.classList.add('option', name);
            document.querySelector('#elements').append(div);
            name = "#" + name;
            document.querySelector(name).addEventListener('change', onChangeHandler);
        }

        if (callback) callback();
    }

    function onChangeHandler(e) {
        changeAction(this.name, this.value, rows);
    }

    function capitalize(string) {
        return string.charAt(0).toUpperCase() + string.slice(1);
    }

    /*------------------------------------------------------------------------------------------*/
    //Initialize select controls.
    function initSelect(i, cols, defaultFields, defaultColumns, storageResponse) {

        // var handleResponse = function(items) {
        var fieldId = defaultFields[i];
        // console.log('initSelect.onStorage', fieldId, i, items, items[i], docKey);
        // var i = parseInt(fieldId.substr(5,1)); //Done. TODO: pass in i to boost speed.
        var valuesArray = [];
        if (storageResponse[docKey] && Array.isArray(storageResponse[docKey])) {
            valuesArray = storageResponse[docKey]; //Get array using the document id as the object key value.
        }
        // else { //Initialize localStorage for the doc if no record is found.
        //   chrome.storage.local.set({[docKey] : defaultColumns}, function(r){ console.log(r); });
        // }
        ////////////////////////////
        //TODO: Move this to it's own function and rewrite. It should store create an initial default menu set on init.
        var selectedOption;

        if (valuesArray && valuesArray[i]) { //If i in the array exists use that. //Should we check that that col still exists in document?
            console.log('Existing value:', valuesArray[i]);
            //Updates the select control position.
            document.querySelector("select[name='" + defaultFields[i] + "']").value = (valuesArray[i]);
            selectedOption = valuesArray[i];
        } else {
            console.log('No value.');

            selectedOption = defaultLayout(cols, defaultColumns[i], defaultColumns);

            valuesArray[i] = selectedOption; //Update the default value in the variable array.

            console.log('Set value of select.', docKey, selectedOption);
            document.querySelector("select[name='" + fieldId + "']").value = (selectedOption);
        }
        return selectedOption;
        //changeAction(formName, elementName);
        // };
    }

    var nextCol = 0; //Needs to be global so that it persists between calls.

    //If the spreadsheet does not have a record in the cache,
    //this function will find either the default Citable columns or the next unique column.
    function defaultLayout(cols, column, defaultColumns) {
        console.log('defaultLayout()', column, cols, defaultColumns);

        var findUnique = function () {
            console.log('Default column not found. Searching for next unique column.', cols.length);
            for (var i = nextCol; i < cols.length; i++) {
                if (defaultColumns.indexOf(cols[i]) == -1) {
                    nextCol = i + 1; //Start from the next position in the spreadsheet cols.
                    return cols[i];
                }
            }
            return 'none'; //If we run out of columns return 'none'.
        };

        return cols.indexOf(column) > -1 ? column : findUnique();
    }


    ///////////////////////////////////////////////////////
    document.addEventListener("DOMContentLoaded", function (event) {
        [].slice.call(document.querySelectorAll('.has-indicator')).map((parent) => {
            parent.addEventListener('scroll', updateIndicator);
        });
    });

    function updateIndicator(e) {
        var parent = e.target;
        var indicator = parent.querySelector('.indicator');
        indicator.style.top = getIndicatorPosition(parent, indicator) + 'px';
        var pageNumber = indicator.querySelector('.pageNum');
        pageNumber.innerText = getPageNumber(parent, '.page:not(.loading)');

        function getIndicatorPosition(parent, indicator) {
            return Math.ceil((parent.scrollTop) * (parent.offsetHeight - indicator.offsetHeight) / (parent.scrollHeight - parent.offsetHeight));
        }

        function getPageNumber(parent, pageSelector) {
            var pages = parent.querySelectorAll(pageSelector);
            var currentPage = {
                page: 0,
                percent: 0
            };
            for (var i = 0; i < pages.length; i++) {
                percent = percentScrolledIntoView(pages[i], parent);
                if (percent > currentPage.percent) {
                    currentPage.page = i + 1;
                    currentPage.percent = percent;
                }
            }
            return currentPage.page;
        }

        function percentScrolledIntoView(element, parent) {
            var docViewTop = parent.scrollTop;
            var docViewBottom = docViewTop + parent.offsetHeight;

            var elemTop = element.offsetTop;
            var elemHeight = element.offsetHeight;
            var elemBottom = elemTop + elemHeight;

            var percent = ((((elemBottom <= docViewBottom) ? elemBottom : docViewBottom) - ((elemTop >= docViewTop) ? elemTop : docViewTop)) / elemHeight);
            return percent;
        }
    }

    //Synchonous interface for chrome.storage.local.get
    function SyncChromeStorage() {}

    SyncChromeStorage.prototype.get = function (key) {

        chrome.storage.local.get(key, function (r) {
            console.log('SyncChromeStorage.prototype.get', key, r, r[key]);
            return r[key];
        });
    };

    SyncChromeStorage.prototype.set = function (obj) {
        chrome.storage.local.set(obj, function (r) {
            return r;
        });
    };

    var localStor = new SyncChromeStorage();

    ///////////////////////////////////////////////////////////////////////////////////

    function startup() {
        console.log('startup');

        var onStorage = function (items) {
            console.log('startup.onStorage', document.URL, items);

            var defaultDoc = items.defaultDoc; //localStorage['defaultDoc'];

            if (defaultDoc != undefined) {
                console.log('items.defaultDoc', defaultDoc);
                try {
                    docKey = parseURLParams(document.URL).key[0];
                    title = parseURLParams(document.URL).title[0];
                } catch (e) {
                    docKey = defaultDoc.id;
                    title = defaultDoc.title;
                }

                // $('#selection').html('<div><span class="Droid regular">Document: </span><span id="title" class="Droid bold" name="title">' + title + '</span></div>');
                document.getElementById('selection').innerHTML = '<div><span class="Droid regular">Document: </span><span id="title" class="Droid bold" name="title">' + title + '</span></div>';
                var printexport = new printExportClass(bgPage, docKey);
                printexport.gdocs.printDocument(null, (data) => {
                    rows = data;
                    processRowsCallback(rows);
                }); //In printexport.js
                // gdocs.start(); //Refactor getting the doc list.
            } else {
                //There is no default document set.
                //This page was loaded from the app icon and not from a document.
                console.log('Get doc from menu');
                // gdocs.start(getDocId); //Refactor getting the doc list.
            }

            //Initialized the layout CSS for the radio controls.
            //value, key, formName, elementName, callback
            document.getElementById('loading').addClassName(items.orientation);
            // initCheck(items.m, false, 'mForm', 'm'); //if using the template switcher
            initRadio(items.orientation, 'landscape', 'radioControls', 'pages', toggleCSS);
            initRadio(items.font, 'Droid', 'radioControls', 'font', setFontIcon);
        };
        chrome.storage.local.get(null, onStorage);
    }
})();

//Polyfill
if (window.NodeList && !NodeList.prototype.forEach) {
    NodeList.prototype.forEach = Array.prototype.forEach;
}

// Source: https://github.com/jserz/js_piece/blob/master/DOM/ParentNode/append()/append().md
(function (arr) {
    arr.forEach(function (item) {
        if (item.hasOwnProperty('append')) {
            return;
        }
        Object.defineProperty(item, 'append', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: function append() {
                var argArr = Array.prototype.slice.call(arguments),
                    docFrag = document.createDocumentFragment();

                argArr.forEach(function (argItem) {
                    var isNode = argItem instanceof Node;
                    docFrag.appendChild(isNode ? argItem : document.createTextNode(String(argItem)));
                });

                this.appendChild(docFrag);
            }
        });
    });
})([Element.prototype, Document.prototype, DocumentFragment.prototype]);